#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
const path = process.argv[process.argv.indexOf('-i') + 1]
appendFileSync(
  join(dirname(path), 'ffmpeg.jsonl'),
  JSON.stringify(process.argv.slice(2)) + '\n',
)
if (basename(path) === 'broken') process.exit(1)
