import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Add an external browser dependency only with an isolated browser-consumer proof.
const browserDependencies = new Set()
const publicEntries = {
  '@kipster/core/protocol': 'protocol/index.ts',
  '@kipster/core/client': 'protocol/client/index.ts',
  '@kipster/core/adapter': 'adapter-api/index.ts',
}
const compilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${filename}`)
    if (entry.isDirectory()) return sourceFiles(filename)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [filename] : []
  })
}

// Liveness is one rule: an agent or organization takes new work only while it is provisioned and
// active, tested with kipster.live_agent / kipster.live_organization (isLive in TypeScript). Guards on
// `provisioned = true`, or a restated rule, would miss lifecycle changes.
const rawLiveness = [
  /(?<!\bSET\s+)(?<!,\s*)\b(?:\w+\.)?provisioned\s*=\s*true\b/i,
  /\bprovisioned\s+AND\s+(?:\w+\.)?lifecycle\s*=\s*\\?'active/i,
]

function migrationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return migrationFiles(filename)
    const number = /^(\d+)_.*\.sql$/.exec(entry.name)?.[1]
    return number ? [filename] : []
  })
}

function rawLivenessProblems(files, relative) {
  const problems = []
  const bare = /(?:\b(?:WHERE|AND|OR)\s+\(*\s*|^\s*)(?:\w+\.)?provisioned\b(?!\s*=\s*false)/i
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const inspect = (text, start) => {
      // Explicit visibility reads include archived rows. This annotation belongs to the SQL
      // expression itself, so it cannot exempt unrelated admission queries in the same file.
      if (text.includes('/* lifecycle visibility */')) return
      if (rawLiveness.some(pattern => pattern.test(text)) || bare.test(text)) {
        const line = content.slice(0, start).split('\n').length
        problems.push(`${relative(file)}:${line}: test liveness with kipster.live_agent / kipster.live_organization (isLive), not a raw provisioned predicate`)
      }
    }
    // The live helpers define the rule, so their marked lines are the only raw predicates allowed.
    if (file.endsWith('.sql')) { inspect(content.replace(/^.*\/\* live rule \*\/.*$/gm, ''), 0); continue }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const visit = node => {
      if (ts.isStringLiteralLike(node)) inspect(node.text, node.getStart(source))
      else if (ts.isTemplateExpression(node)) inspect(node.getText(source), node.getStart(source))
      else ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return problems
}

function importsOf(filename) {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = []
  function add(node, argument) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    imports.push({ specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null, line })
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null)
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      add(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const reference of [...source.referencedFiles, ...source.typeReferenceDirectives]) {
    imports.push({ specifier: null, line: source.getLineAndCharacterOfPosition(reference.pos).line + 1 })
  }
  return imports
}

/** Check static and literal dynamic imports, including type-only dependencies. */
export function checkBoundaries(sourceRoot, dependencies = []) {
  const root = realpathSync(sourceRoot)
  const files = sourceFiles(root)
  const graph = new Map()
  const problems = []
  const declared = new Set(dependencies)
  const relative = (filename) => path.relative(root, filename).split(path.sep).join('/')
  const moduleOf = (filename) => /^modules\/([^/]+)\//.exec(relative(filename))?.[1]
  const inside = (filename) => !path.isAbsolute(path.relative(root, filename)) &&
    !path.relative(root, filename).startsWith(`..${path.sep}`) && path.relative(root, filename) !== '..'

  for (const file of files) {
    const edges = []
    for (const { specifier, line } of importsOf(file)) {
      const location = `${relative(file)}:${line}`
      if (specifier === null) {
        // Installation composition loads explicit configured adapter entries. Domain and
        // browser code still cannot resolve computed dependencies.
        if (relative(file) === 'workflows/adapter-runner.ts' || relative(file) === 'host.ts') continue
        problems.push(`${location}: dependency must use an inspectable literal import, without reference directives`)
        continue
      }
      let target
      if (Object.hasOwn(publicEntries, specifier)) {
        target = path.join(root, publicEntries[specifier])
      } else if (specifier.startsWith('.')) {
        target = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName
        if (!target) {
          problems.push(`${location}: cannot resolve ${specifier}`)
          continue
        }
      } else {
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        if (!isBuiltin(specifier) && !declared.has(packageName)) {
          problems.push(`${location}: undeclared or private dependency ${specifier}`)
        }
        edges.push({ external: specifier, packageName, location })
        continue
      }
      if (!inside(target) || !files.includes(target)) {
        problems.push(`${location}: dependency must resolve to a source file inside Core: ${specifier}`)
        continue
      }
      const targetModule = moduleOf(target)
      if (targetModule && targetModule !== moduleOf(file) && relative(target) !== `modules/${targetModule}/public.ts`) {
        problems.push(`${location}: access ${targetModule} through modules/${targetModule}/public.ts`)
      }
      edges.push({ target, location })
    }
    graph.set(file, edges)
  }

  problems.push(...rawLivenessProblems([...files, ...migrationFiles(root)], relative))

  // Follow transitive dependencies as well, so a barrel/helper cannot hide a violation.
  for (const origin of files) {
    const originName = relative(origin)
    const browser = originName.startsWith('protocol/')
    const adapter = originName.startsWith('adapter-api/')
    const domain = Boolean(moduleOf(origin))
    if (!browser && !adapter && !domain) continue
    const visited = new Set()
    function visit(file) {
      if (visited.has(file)) return
      visited.add(file)
      for (const edge of graph.get(file) ?? []) {
        if (edge.external) {
          if (browser && (isBuiltin(edge.external) || !browserDependencies.has(edge.packageName))) {
            problems.push(`${edge.location}: browser surface ${originName} cannot depend on ${edge.external}`)
          }
          continue
        }
        const targetName = relative(edge.target)
        if (browser && !targetName.startsWith('protocol/')) {
          problems.push(`${edge.location}: browser surface ${originName} cannot depend on ${targetName}`)
        }
        if (adapter && !targetName.startsWith('adapter-api/') && !targetName.startsWith('protocol/')) {
          problems.push(`${edge.location}: public adapter contract cannot depend on ${targetName}`)
        }
        if (domain && /^(transport|runtime|workflows)\//.test(targetName)) {
          problems.push(`${edge.location}: domain module ${moduleOf(origin)} cannot depend on ${targetName}`)
        }
        visit(edge.target)
      }
    }
    visit(origin)
  }
  return [...new Set(problems)].sort()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const problems = checkBoundaries(fileURLToPath(new URL('../src/', import.meta.url)), [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Core import boundaries passed (including type imports and transitive dependencies), and liveness uses the live helpers.')
  }
}
