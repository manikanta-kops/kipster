function semver(version: string): { numbers: bigint[]; prerelease: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) throw new TypeError(`Invalid semver: ${version}`)
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new TypeError(`Invalid semver: ${version}`)
  return { numbers: match.slice(1, 4).map(BigInt), prerelease }
}

/** Semver precedence, including numeric prereleases; build metadata has no precedence. */
export function compareVersions(left: string, right: string): number {
  const a = semver(left), b = semver(right)
  const compare = (x: bigint | string | boolean, y: bigint | string | boolean): number => x < y ? -1 : x > y ? 1 : 0
  for (let index = 0; index < 3; index++) {
    const order = compare(a.numbers[index]!, b.numbers[index]!)
    if (order) return order
  }
  if (!a.prerelease.length || !b.prerelease.length) return compare(!a.prerelease.length, !b.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === undefined || y === undefined) return compare(x !== undefined, y !== undefined)
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    const order = numericX && numericY ? compare(BigInt(x), BigInt(y))
      : numericX !== numericY ? compare(!numericX, !numericY) : compare(x, y)
    if (order) return order
  }
  return 0
}
