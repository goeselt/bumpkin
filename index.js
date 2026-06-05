'use strict'

const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { buildComment, MARKER } = require('./comment.js')
const { getPRCommits, upsertComment, MAX_PR_COMMITS } = require('./github.js')
const {
  analyzeCommit,
  buildLogArgs,
  buildReleasePathspecs,
  bumpGt,
  findLatestTag,
  firstLine,
  parseCommitLog,
  parsePaths,
  resolveVersion,
  validate,
} = require('./version.js')

// Diagnostic markers. Narrative lines carry a greppable `[bumpkin]` prefix;
// problems use GitHub workflow-command annotations (which also carry `Bumpkin` so they stay greppable).
// Every run ends with a single `result=pass|fail` line so a reader can find the verdict fast.
function log(message) {
  process.stdout.write(`[bumpkin] ${message}\n`)
}

function warn(message) {
  process.stdout.write(`::warning title=Bumpkin::${message}\n`)
}

function fail(message) {
  process.stdout.write(`::error title=Bumpkin::${message}\n`)
}

function input(name, fallback = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback
}

function boolInput(name, fallback) {
  const raw = input(name, fallback ? 'true' : 'false')
    .trim()
    .toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function eventPayload() {
  const eventPath = process.env['GITHUB_EVENT_PATH']
  if (!eventPath) return {}
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'))
}

function isPREvent(eventName) {
  return eventName === 'pull_request' || eventName === 'pull_request_target'
}

function setOutput(name, value) {
  const outputFile = process.env['GITHUB_OUTPUT']
  if (!outputFile) return
  fs.appendFileSync(outputFile, `${name}=${value}\n`)
}

function writeVersionOutputs(result) {
  setOutput('release-needed', String(result.releaseNeeded))
  setOutput('bump-level', result.bumpLevel)
  setOutput('current-version', result.currentVersion)
  setOutput('next-version', result.nextVersion)
  setOutput('previous-tag', result.previousTag)
  setOutput('release-tag', result.releaseTag)
  setOutput('major-tag', result.majorTag)
  setOutput('minor-tag', result.minorTag)
}

async function runPullRequest({ payload, token, postComment }) {
  const pr = payload.pull_request
  if (!pr) throw new Error('pull_request payload is missing')

  const repo = payload.repository?.full_name
  if (!repo) throw new Error('repository.full_name is missing from event payload')

  const title = pr.title ?? ''
  const prNumber = pr.number
  const titleResult = validate(title, { strict: true })

  log(`mode=pull-request repository=${repo} pr=${prNumber} pr-comment=${postComment}`)
  log(`pr-title=${JSON.stringify(title)}`)
  log(`title-valid=${titleResult.valid} title-bump=${titleResult.bumpLevel ?? '-'}`)

  let commitAnalysis = []
  let maxCommitBump = 'none'

  if (token) {
    const commits = await getPRCommits(token, repo, prNumber)
    if (commits.length >= MAX_PR_COMMITS) {
      warn(
        `PR has at least ${MAX_PR_COMMITS} commits; the GitHub API truncates the list, so a breaking change beyond that limit may be missed.`,
      )
    }
    commitAnalysis = commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      result: analyzeCommit(c.commit.message),
    }))
    maxCommitBump = commitAnalysis.reduce((max, { result }) => {
      const bump = result.bumpLevel ?? 'none'
      return bumpGt(bump, max) ? bump : max
    }, 'none')
    log(`commits-analyzed=${commitAnalysis.length} max-commit-bump=${maxCommitBump}`)
  } else {
    warn('github-token is empty; skipping PR commit analysis and comment')
    log('commit-analysis=skipped reason=no-token')
  }

  if (postComment && token) {
    try {
      await upsertComment(
        token,
        repo,
        prNumber,
        MARKER,
        buildComment({ titleResult, title, commitAnalysis, maxCommitBump }),
      )
      log('comment=updated')
    } catch (err) {
      warn(`could not post PR comment: ${err.message}`)
      log('comment=failed')
    }
  } else {
    log(`comment=skipped reason=${postComment ? 'no-token' : 'pr-comment-false'}`)
  }

  setOutput('release-needed', String(titleResult.valid && titleResult.bumpLevel !== 'none'))
  setOutput('bump-level', titleResult.valid ? titleResult.bumpLevel : '')

  if (!titleResult.valid) {
    for (const err of titleResult.errors) fail(err)
    log('result=fail reason=invalid-title')
    process.exit(1)
  }

  if (bumpGt(maxCommitBump, titleResult.bumpLevel)) {
    for (const { sha, message, result } of commitAnalysis) {
      if (bumpGt(result.bumpLevel ?? 'none', titleResult.bumpLevel)) {
        fail(
          `commit ${sha.slice(0, 7)} implies ${result.bumpLevel} bump > title ${titleResult.bumpLevel}: ${firstLine(message)}`,
        )
      }
    }
    fail(`commits require ${maxCommitBump} bump but PR title signals ${titleResult.bumpLevel}`)
    log('result=fail reason=bump-conflict')
    process.exit(1)
  }

  log(`result=pass title-bump=${titleResult.bumpLevel} release-needed=${titleResult.bumpLevel !== 'none'}`)
}

function runVersion() {
  const scope = input('RELEASE-SCOPE')
  const prefix = input('TAG-PREFIX', 'v')
  const initialVersion = input('INITIAL-VERSION', '0.0.0')
  const releasePaths = parsePaths(input('RELEASE-PATHS'))
  const releaseIgnorePaths = parsePaths(input('RELEASE-IGNORE-PATHS'))

  log('mode=version')
  log(`inputs release-scope=${scope || '-'} tag-prefix=${prefix || '-'} initial-version=${initialVersion}`)
  if (releasePaths.length > 0) log(`release-paths=${releasePaths.join(' ')}`)
  if (releaseIgnorePaths.length > 0) log(`release-ignore-paths=${releaseIgnorePaths.join(' ')}`)

  // The tag pattern is interpolated into `git tag --list` before any `--`, so a leading dash would be parsed as a flag.
  // Reject it (inputs are trusted, but this keeps a misconfiguration from silently turning into an option).
  for (const [name, value] of [
    ['tag-prefix', prefix],
    ['release-scope', scope],
  ]) {
    if (value.startsWith('-')) throw new Error(`${name} must not start with "-", got ${JSON.stringify(value)}`)
  }

  const tagPattern = scope ? `${scope}/${prefix}*` : `${prefix}*`
  const tagOutput = git(['tag', '--list', tagPattern, '--sort=-v:refname'])
  const previousTag = findLatestTag(tagOutput, scope, prefix)
  log(`tag-pattern=${tagPattern} previous-tag=${previousTag || '-'}`)

  const pathspecs = buildReleasePathspecs(releasePaths, releaseIgnorePaths)
  if (pathspecs.length > 0) log(`git-pathspecs=${pathspecs.join(' ')}`)
  const commitMessages = parseCommitLog(git(buildLogArgs(previousTag, pathspecs)))
  log(`commits-analyzed=${commitMessages.length}`)

  const result = resolveVersion({ initialVersion, tagOutput, commitMessages, scope, prefix })
  writeVersionOutputs(result)
  log(
    `result=pass release-needed=${result.releaseNeeded} bump=${result.bumpLevel} current=${result.currentVersion} next=${result.nextVersion} release-tag=${result.releaseTag}`,
  )
}

;(async () => {
  const eventName = process.env['GITHUB_EVENT_NAME'] ?? ''
  const payload = eventPayload()

  if (isPREvent(eventName)) {
    await runPullRequest({
      payload,
      token: input('GITHUB-TOKEN'),
      postComment: boolInput('PR-COMMENT', true),
    })
    return
  }

  runVersion()
})().catch((err) => {
  fail(err.message)
  log('result=fail reason=exception')
  process.exit(1)
})
