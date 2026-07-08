const GITHUB_API = "https://api.github.com";
const NETLIFY_API = "https://api.netlify.com/api/v1";

const OWNER = process.env.NOG_GITHUB_OWNER;
const REPO = process.env.NOG_GITHUB_REPO;
const DEFAULT_BRANCH = process.env.NOG_DEFAULT_BRANCH || "main";
const FORK_BRANCH = process.env.NOG_FORK_BRANCH || "nog-fork";
const DOC_PATH = process.env.NOG_CONTENT_PATH || "content/_index.md";
const GITHUB_TOKEN = process.env.NOG_GITHUB_TOKEN;
const NETLIFY_TOKEN = process.env.NOG_NETLIFY_TOKEN;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      return await handlePreview(event);
    }
    if (event.httpMethod === "POST") {
      return await handleConfirm(event);
    }
    return respond(405, "Method not allowed.");
  } catch (err) {
    return respond(500, page("Error", `<p>Something went wrong: ${escapeHtml(err.message)}</p>`));
  }
};

async function handlePreview(event) {
  const submissionId = event.queryStringParameters && event.queryStringParameters.submission_id;
  if (!submissionId) return respond(400, page("Missing submission", "<p>No submission_id given.</p>"));

  const submission = await getSubmission(submissionId);
  if (!submission) return respond(404, page("Not found", "<p>That submission could not be found.</p>"));

  const data = submission.data || {};
  const hasCandidate = !!(data.candidate_edit && data.candidate_edit.trim());
  const alreadyResolved = await findExistingResolution(submissionId);

  const body = `
    <dl class="meta">
      <dt>Document</dt><dd>${escapeHtml(data.doc_id || "")}</dd>
      <dt>Block</dt><dd>${escapeHtml(data.block_id || "")}</dd>
      <dt>From</dt><dd>${escapeHtml(data.commenter_name || "anonymous")}</dd>
    </dl>
    <h2>Comment</h2>
    <blockquote>${escapeHtml(data.comment_text || "")}</blockquote>
    ${hasCandidate
      ? `<h2>Text that will be committed</h2><blockquote class="candidate">${escapeHtml(data.candidate_edit)}</blockquote>`
      : `<p><em>No replacement wording was proposed. This will be a discussion-only resolution — the paragraph text won't change, but the resolution will still be committed to the audit trail.</em></p>`}
    ${alreadyResolved
      ? `<p class="warn">This submission has already been resolved on the open fork. Confirming again will not create a second commit.</p>`
      : ""}
    <form method="POST">
      <input type="hidden" name="submission_id" value="${escapeHtml(submissionId)}">
      <label for="resolved_by">Your name (resolver, optional)</label>
      <input type="text" id="resolved_by" name="resolved_by">
      <button type="submit">Confirm &amp; commit</button>
    </form>
  `;
  return respond(200, page("Resolve comment", body));
}

async function handleConfirm(event) {
  const params = parseForm(event.body || "");
  const submissionId = params.submission_id;
  const resolvedBy = (params.resolved_by || "").trim() || "unspecified";
  if (!submissionId) return respond(400, page("Missing submission", "<p>No submission_id given.</p>"));

  const submission = await getSubmission(submissionId);
  if (!submission) return respond(404, page("Not found", "<p>That submission could not be found.</p>"));

  const data = submission.data || {};
  const docId = data.doc_id || "";
  const blockId = data.block_id || "";
  const commentText = data.comment_text || "";
  const candidateEdit = (data.candidate_edit || "").trim();
  const raisedBy = data.commenter_name || "anonymous";

  const alreadyResolved = await findExistingResolution(submissionId);
  if (alreadyResolved) {
    return respond(200, page("Already resolved",
      `<p>This submission was already resolved on the <code>${escapeHtml(FORK_BRANCH)}</code> fork. Nothing was committed.</p>`));
  }

  await ensureForkBranch();

  const trailer = {
    schema: "nog/commit-context/v0",
    doc_id: docId,
    resolutions: [{
      block_id: blockId,
      comment_id: submissionId,
      raised_by: raisedBy,
      excerpt: excerpt(commentText, 240),
      resolved_by: resolvedBy
    }]
  };
  const message = `Resolve comment on ${blockId}\n\nNog-Context: ${JSON.stringify(trailer)}`;

  const sha = candidateEdit
    ? await commitWithTextChange(blockId, candidateEdit, message)
    : await commitEmpty(message);

  return respond(200, page("Resolved",
    `<p>Committed <code>${escapeHtml(sha.slice(0, 10))}</code> to <code>${escapeHtml(FORK_BRANCH)}</code>.</p>
     <p>${candidateEdit ? "The proposed wording is now the committed text for this block." : "Recorded as a discussion-only resolution — no text changed."}</p>`));
}

async function getSubmission(submissionId) {
  const res = await fetch(`${NETLIFY_API}/submissions/${encodeURIComponent(submissionId)}`, {
    headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Netlify API error ${res.status}`);
  return res.json();
}

async function findExistingResolution(submissionId) {
  const branchRes = await gh(`/repos/${OWNER}/${REPO}/commits?sha=${FORK_BRANCH}&per_page=100`);
  if (branchRes.status === 404 || branchRes.status === 409) return false;
  if (!branchRes.ok) throw new Error(`GitHub API error listing commits: ${branchRes.status}`);
  const commits = await branchRes.json();
  const needle = `"comment_id":"${submissionId}"`;
  return commits.some((c) => c.commit.message.includes(needle));
}

async function ensureForkBranch() {
  const existing = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${FORK_BRANCH}`);
  if (existing.ok) return;
  const base = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${DEFAULT_BRANCH}`);
  if (!base.ok) throw new Error(`Could not read default branch ref: ${base.status}`);
  const baseData = await base.json();
  const create = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${FORK_BRANCH}`, sha: baseData.object.sha })
  });
  if (!create.ok) throw new Error(`Could not create fork branch: ${create.status}`);
}

async function getHeadCommit() {
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${FORK_BRANCH}`);
  if (!ref.ok) throw new Error(`Could not read fork branch ref: ${ref.status}`);
  const refData = await ref.json();
  const commitRes = await gh(`/repos/${OWNER}/${REPO}/git/commits/${refData.object.sha}`);
  if (!commitRes.ok) throw new Error(`Could not read head commit: ${commitRes.status}`);
  const commit = await commitRes.json();
  return { sha: refData.object.sha, treeSha: commit.tree.sha };
}

async function commitEmpty(message) {
  const head = await getHeadCommit();
  return createCommit(head.sha, head.treeSha, message);
}

async function commitWithTextChange(blockId, candidateEdit, message) {
  const head = await getHeadCommit();

  const fileRes = await gh(`/repos/${OWNER}/${REPO}/contents/${DOC_PATH}?ref=${FORK_BRANCH}`);
  if (!fileRes.ok) throw new Error(`Could not read document: ${fileRes.status}`);
  const file = await fileRes.json();
  const raw = Buffer.from(file.content, "base64").toString("utf8");

  const updated = replaceBlock(raw, blockId, candidateEdit);
  if (updated === null) throw new Error(`Block marker for ${blockId} not found in document`);

  const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: updated, encoding: "utf-8" })
  });
  if (!blob.ok) throw new Error(`Could not create blob: ${blob.status}`);
  const blobData = await blob.json();

  const tree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: head.treeSha,
      tree: [{ path: DOC_PATH, mode: "100644", type: "blob", sha: blobData.sha }]
    })
  });
  if (!tree.ok) throw new Error(`Could not create tree: ${tree.status}`);
  const treeData = await tree.json();

  return createCommit(head.sha, treeData.sha, message);
}

async function createCommit(parentSha, treeSha, message) {
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
  });
  if (!commit.ok) throw new Error(`Could not create commit: ${commit.status}`);
  const commitData = await commit.json();

  const update = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${FORK_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commitData.sha })
  });
  if (!update.ok) throw new Error(`Could not update branch ref: ${update.status}`);

  return commitData.sha;
}

function replaceBlock(raw, blockId, candidateEdit) {
  const markerLine = `<!-- nog:${blockId} -->`;
  const start = raw.indexOf(markerLine);
  if (start === -1) return null;
  const contentStart = start + markerLine.length;

  const nextMarker = raw.indexOf("<!-- nog:blk-", contentStart);
  const contentEnd = nextMarker === -1 ? raw.length : nextMarker;

  const before = raw.slice(0, contentStart);
  const after = raw.slice(contentEnd);
  return `${before}\n\n${candidateEdit.trim()}\n\n${after.replace(/^\s+/, "")}`;
}

function gh(path, opts) {
  return fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts && opts.headers)
    }
  });
}

function excerpt(text, max) {
  const t = (text || "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function parseForm(body) {
  const out = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
  }
  return out;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1.5rem;line-height:1.6;color:#1c1f24;}
blockquote{border-left:3px solid #d8dde3;margin:0 0 1rem;padding-left:0.8rem;color:#333;}
.candidate{border-left-color:#2a5db0;background:#eef3fb;padding:0.6rem 0.8rem;}
.meta{display:grid;grid-template-columns:auto 1fr;gap:0.2rem 1rem;font-size:0.9rem;color:#555;margin-bottom:1.5rem;}
.meta dt{font-weight:600;}
.warn{background:#fff4e5;border:1px solid #f0c36d;padding:0.6rem 0.8rem;border-radius:6px;}
form{margin-top:1.5rem;}
label{display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.3rem;}
input[type=text]{width:100%;padding:0.5rem;border:1px solid #d8dde3;border-radius:6px;margin-bottom:1rem;font:inherit;}
button{background:#2a5db0;color:#fff;border:none;border-radius:6px;padding:0.6rem 1.2rem;font-size:0.95rem;cursor:pointer;}
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function respond(statusCode, bodyOrHtml) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: typeof bodyOrHtml === "string" ? bodyOrHtml : String(bodyOrHtml)
  };
}
