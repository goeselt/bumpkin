'use strict'

const https = require('node:https')

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bumpkin',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${method} ${path} --> HTTP ${res.statusCode}: ${raw}`))
          return
        }
        resolve(raw ? JSON.parse(raw) : null)
      })
    })

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// GitHub caps "list PR commits" at 250 results regardless of pagination:
// https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
const MAX_PR_COMMITS = 250

async function getPRCommits(token, repo, prNumber) {
  const commits = []
  for (let page = 1; ; page++) {
    const batch = await request('GET', `/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    commits.push(...batch)
    if (batch.length < 100) break
  }
  return commits
}

async function upsertComment(token, repo, prNumber, marker, body) {
  // Find existing bot comment
  let existing = null
  let page = 1
  for (;;) {
    const batch = await request('GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    existing = batch.find((c) => typeof c.body === 'string' && c.body.includes(marker)) ?? null
    if (existing || batch.length < 100) break
    page++
  }

  if (existing) {
    // Skip the write when nothing changed. Avoids a redundant comment edit,
    // which is the only thing that could feed a comment-triggered workflow loop.
    if (normalize(existing.body) === normalize(body)) {
      return existing
    }
    return request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, token, { body })
  }
  return request('POST', `/repos/${repo}/issues/${prNumber}/comments`, token, { body })
}

/** Normalizes line endings so a CRLF round-trip does not count as a change. */
function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

module.exports = { getPRCommits, upsertComment, MAX_PR_COMMITS }
