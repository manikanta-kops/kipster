// Kipster backend launcher.
//
// launchd starts this signed executable for the Core host and the updater, so
// macOS privacy attributes their work, and the work of every child, to the
// Kipster app instead of to the Node binary. The launcher reads the selected
// Node from <home>/runtime.json (outside the signed bundle), starts the stable
// role script with it, stays its parent, forwards termination signals and exits
// with the child's status. It never daemonizes or replaces itself with Node.
//
//   Kipster --role host    --home <home>
//   Kipster --role updater --home <home>
//   Kipster --role cli     --home <home> [-- <arguments>...]
//
// In the cli role, `runtime --node <absolute-path>` runs with that candidate
// Node, so a missing stored runtime can always be replaced.

#import <Foundation/Foundation.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

enum { EXIT_USAGE = 64, EXIT_CONFIG = 78, EXIT_SPAWN = 71 };

static volatile sig_atomic_t child = 0;
static const int forwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
static const int forwardedCount = sizeof forwarded / sizeof forwarded[0];

static void forward(int signal) {
  pid_t pid = child;
  if (pid > 0) kill(pid, signal);
}

static int fail(int code, NSString *message) {
  fprintf(stderr, "Kipster: %s\n", message.UTF8String);
  return code;
}

static NSString *usage(void) {
  return @"usage: Kipster --role host|updater|cli --home <absolute-home> [-- <arguments>...]";
}

// The home and its manifest must belong to the account running the job and must
// not be writable by anyone else; otherwise another user could choose the Node.
static BOOL ownedPrivately(const char *path, BOOL directory, BOOL requirePrivate) {
  struct stat info;
  if (lstat(path, &info) != 0) return NO;
  if (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode)) return NO;
  if (info.st_uid != getuid()) return NO;
  return (info.st_mode & (requirePrivate ? 077 : 022)) == 0;
}

static BOOL executableFile(NSString *path) {
  struct stat info;
  return path.isAbsolutePath && stat(path.fileSystemRepresentation, &info) == 0 && S_ISREG(info.st_mode) && access(path.fileSystemRepresentation, X_OK) == 0;
}

static NSString *storedNode(NSString *home, NSString **problem) {
  NSString *manifest = [home stringByAppendingPathComponent:@"runtime.json"];
  if (!ownedPrivately(manifest.fileSystemRepresentation, NO, YES)) {
    *problem = [NSString stringWithFormat:@"%@ is missing or is not a private file owned by this user.", manifest];
    return nil;
  }
  NSData *bytes = [NSData dataWithContentsOfFile:manifest];
  id value = bytes.length && bytes.length <= 65536 ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
  NSDictionary *manifestValue = [value isKindOfClass:NSDictionary.class] ? value : nil;
  NSString *node = manifestValue[@"node"];
  if (![manifestValue[@"version"] isEqual:@1] || ![node isKindOfClass:NSString.class]) {
    *problem = [NSString stringWithFormat:@"%@ is not a version 1 runtime manifest.", manifest];
    return nil;
  }
  if (!executableFile(node)) {
    *problem = [NSString stringWithFormat:@"The selected Node %@ is not an executable file.", node];
    return nil;
  }
  return node;
}

static int launch(int argc, const char *argv[]) {
  NSString *role = nil, *home = nil;
  NSMutableArray<NSString *> *rest = [NSMutableArray array];
  int index = 1;
  for (; index < argc; index++) {
    NSString *argument = @(argv[index]);
    if ([argument isEqualToString:@"--"]) { index++; break; }
    if (index + 1 >= argc) return fail(EXIT_USAGE, usage());
    if ([argument isEqualToString:@"--role"] && !role) role = @(argv[++index]);
    else if ([argument isEqualToString:@"--home"] && !home) home = @(argv[++index]);
    else return fail(EXIT_USAGE, usage());
  }
  for (; index < argc; index++) [rest addObject:@(argv[index])];
  if (!role || !home) return fail(EXIT_USAGE, usage());
  if (![@[@"host", @"updater", @"cli"] containsObject:role]) return fail(EXIT_USAGE, usage());
  if (![role isEqualToString:@"cli"] && rest.count) return fail(EXIT_USAGE, @"Only the cli role accepts arguments.");
  if (!home.isAbsolutePath || [home.pathComponents containsObject:@".."] || [home.pathComponents containsObject:@"."] || !ownedPrivately(home.fileSystemRepresentation, YES, NO))
    return fail(EXIT_CONFIG, [NSString stringWithFormat:@"%@ is not an absolute Kipster home directory owned by this user.", home]);

  NSString *node = nil;
  NSUInteger choice = [rest indexOfObject:@"--node"];
  if ([role isEqualToString:@"cli"] && rest.count && [rest[0] isEqualToString:@"runtime"] && choice != NSNotFound && choice + 1 < rest.count) {
    node = rest[choice + 1];
    if (!executableFile(node)) return fail(EXIT_CONFIG, [NSString stringWithFormat:@"%@ is not an executable Node file. Pass its absolute path.", node]);
  } else {
    NSString *problem = nil;
    node = storedNode(home, &problem);
    if (!node) return fail(EXIT_CONFIG, [NSString stringWithFormat:@"%@ Select a supported Node with: %@ runtime --node /absolute/path/to/node",
      problem, [home stringByAppendingPathComponent:@"bin/kipster"]]);
  }

  NSString *script = [home stringByAppendingPathComponent:[role isEqualToString:@"host"] ? @"bin/core.mjs" : @"bin/kipster.mjs"];
  NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithObjects:node, script, nil];
  if ([role isEqualToString:@"updater"]) [arguments addObject:@"apply"];
  [arguments addObjectsFromArray:rest];

  // Children find this Node, npm and npx first, ahead of the job's PATH.
  NSMutableArray<NSString *> *environment = [NSMutableArray array];
  NSString *path = @"/usr/bin:/bin:/usr/sbin:/sbin";
  for (char **entry = environ; *entry; entry++) {
    NSString *item = @(*entry);
    if ([item hasPrefix:@"PATH="]) path = [item substringFromIndex:5];
    else [environment addObject:item];
  }
  [environment addObject:[NSString stringWithFormat:@"PATH=%@:%@", node.stringByDeletingLastPathComponent, path]];

  size_t argumentCount = arguments.count, environmentCount = environment.count;
  char **childArguments = calloc(argumentCount + 1, sizeof(char *));
  char **childEnvironment = calloc(environmentCount + 1, sizeof(char *));
  if (!childArguments || !childEnvironment) return fail(EXIT_SPAWN, @"Out of memory.");
  for (size_t i = 0; i < argumentCount; i++) childArguments[i] = strdup(arguments[i].UTF8String);
  for (size_t i = 0; i < environmentCount; i++) childEnvironment[i] = strdup(environment[i].UTF8String);

  // Block forwarded signals until the child PID is known, so none is lost, and
  // start the child with default dispositions and an empty mask.
  sigset_t blocked, empty, defaults;
  sigemptyset(&blocked); sigemptyset(&empty); sigemptyset(&defaults);
  for (int i = 0; i < forwardedCount; i++) { sigaddset(&blocked, forwarded[i]); sigaddset(&defaults, forwarded[i]); }
  sigaddset(&defaults, SIGPIPE);
  sigprocmask(SIG_BLOCK, &blocked, NULL);

  // A terminal delivers SIGINT and SIGQUIT to the whole foreground group, child
  // included; forwarding them again would interrupt Node twice.
  BOOL interactive = [role isEqualToString:@"cli"] && isatty(STDIN_FILENO);
  for (int i = 0; i < forwardedCount; i++) {
    struct sigaction action = { 0 };
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    action.sa_handler = interactive && (forwarded[i] == SIGINT || forwarded[i] == SIGQUIT) ? SIG_IGN : forward;
    sigaction(forwarded[i], &action, NULL);
  }

  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setsigmask(&attributes, &empty);
  posix_spawnattr_setsigdefault(&attributes, &defaults);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  pid_t pid = 0;
  int spawned = posix_spawn(&pid, childArguments[0], NULL, &attributes, childArguments, childEnvironment);
  posix_spawnattr_destroy(&attributes);
  if (spawned != 0) return fail(EXIT_SPAWN, [NSString stringWithFormat:@"Could not start %@: %s", node, strerror(spawned)]);
  child = pid;
  sigprocmask(SIG_UNBLOCK, &blocked, NULL);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return fail(EXIT_SPAWN, [NSString stringWithFormat:@"Lost the Node process: %s", strerror(errno)]);
  }
  child = 0;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    // Report a terminating signal as the same signal to launchd or the shell. A
    // crashing Node is reported by exit status, so Kipster itself does not crash.
    int signal = WTERMSIG(status);
    if (signal == SIGSEGV || signal == SIGBUS || signal == SIGILL || signal == SIGFPE || signal == SIGABRT || signal == SIGTRAP || signal == SIGSYS) return 128 + signal;
    struct sigaction action = { 0 };
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    sigaction(signal, &action, NULL);
    sigset_t only;
    sigemptyset(&only); sigaddset(&only, signal);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    raise(signal);
    return 128 + signal;
  }
  return EXIT_SPAWN;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool { return launch(argc, argv); }
}
