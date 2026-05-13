---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-13T07:12:00.573Z'
    comment: Created ticket.
id: FLUX-239
title: communicate
status: Grooming
createdBy: Guy
updatedBy: Guy
---
  
const execFileAsync = promisify(execFile);

const router = express.Router();

/\*\*

\* Get the max ticket ID from the remote flux-data branch.

\* This prevents ID collisions when multiple instances create tickets before syncing.

\* Returns 0 if remote check fails (network issue, no remote, etc.)

\*/

async function getMaxIdFromRemote(projectKey: string): Promise<number> {

if (!isOrphanMode()) return 0;

const storeDir = getFluxStoreDir();

try {

// Fetch latest remote state

await execFileAsync('git', \['-C', storeDir, 'fetch', 'origin', 'flux-data'\]);

// List files on remote branch

const { stdout } = await execFileAsync('git', \[

'-C', storeDir, 'ls-tree', '-r', '--name-only', 'origin/flux-data'

\]);

let maxId = 0;

stdout.split('\\n').forEach(file => {

const fileName = path.basename(file);

if (fileName.startsWith`${projectKey}-`) && fileName.endsWith('.md')) {

const idPart = fileName.replace`${projectKey}-`, '').replace('.md', '');

const num = parseInt(idPart, 10);

if (!isNaN(num) && num > maxId) maxId = num;

}

});

return maxId;

} catch (err: any) {

// Network failure, no remote, or auth issue - fall back to local only

console.warn`[tasks] Could not check remote for max ticket ID: ${err.message}`);

return 0;

}

}

router.get('/', (req, res) => {

res.json(Object.values(tasksCache).map(serializeTaskForApi));

});

@@ -71,7 +35,7 @@ [router.post](http://router.post)('/', async (req, res) => {

const { projectKey, status, author, title, body, ...rest } = req.body;

const pKey = projectKey || configCache.projects?.\[0\] || 'PROJECT';

// Check local cache for max ID

// Find max ID from local cache

let maxId = 0;

Object.keys(tasksCache).forEach((key) => {

if (key.startsWith`${pKey}-`)) {

@@ -80,15 +44,6 @@ [router.post](http://router.post)('/', async (req, res) => {

}

});

// In orphan mode, also check remote to prevent ID collisions across instances

if (isOrphanMode()) {

const remoteMaxId = await getMaxIdFromRemote(pKey);

maxId = Math.max(maxId, remoteMaxId);

if (remoteMaxId > 0) {

console.log`[tasks] Remote max ID for ${pKey}: ${remoteMaxId}, using ${maxId + 1}`);

}

}

const nextId = `${pKey}-${maxId + 1}`;

const filePath = path.join(getActiveFluxDir(), `${nextId}.md`);

const createdAt = new Date().toISOString();
