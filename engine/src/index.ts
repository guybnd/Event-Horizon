import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

const app = express();
app.use(cors());
app.use(express.json());

const FLUX_DIR = path.join(__dirname, '../../.flux');
const CONFIG_FILE = path.join(FLUX_DIR, 'config.json');
const REPO_ROOT = path.resolve(FLUX_DIR, '..');
const SKILL_SOURCE_PATH = path.join(FLUX_DIR, 'skills', 'event-horizon-agent.md');
const WORKSPACE_SKILL_PATH = path.join(REPO_ROOT, '.github', 'skills', 'event-horizon', 'SKILL.md');

let tasksCache: Record<string, any> = {};
let configCache: any = {
  columns: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }],
  hiddenStatuses: [{ name: "Backlog" }],
  projects: ["FLUX"],
  users: [{ name: "Guy" }, { name: "Agent" }],
  tags: [
    { name: "bug", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
    { name: "feature", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
    { name: "docs", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" }
  ],
  priorities: [
    { name: "Critical", icon: "AlertCircle", color: "text-red-500" },
    { name: "High", icon: "ChevronUp", color: "text-orange-500" },
    { name: "Medium", icon: "Equal", color: "text-amber-500" },
    { name: "Low", icon: "ChevronDown", color: "text-emerald-500" },
    { name: "None", icon: "Equal", color: "text-gray-400" }
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true
};

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const loaded = JSON.parse(data);
    
    // Migration: Convert string arrays to object arrays
    if (loaded.columns?.length && typeof loaded.columns[0] === 'string') loaded.columns = loaded.columns.map((s: string) => ({ name: s }));
    if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string') loaded.hiddenStatuses = loaded.hiddenStatuses.map((s: string) => ({ name: s }));
    if (loaded.users?.length && typeof loaded.users[0] === 'string') loaded.users = loaded.users.map((s: string) => ({ name: s }));
    if (loaded.tags?.length && typeof loaded.tags[0] === 'string') loaded.tags = loaded.tags.map((s: string) => ({
      name: s,
      color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
    }));
    if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
      loaded.priorities = configCache.priorities;
    }
    if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
      loaded.priorities = loaded.priorities.map((name: string) => ({
        name,
        icon: 'Equal',
        color: 'text-gray-400'
      }));
    }

    configCache = { ...configCache, ...loaded };
    console.log('Loaded config');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveConfig(configCache);
    } else {
      console.error('Failed to load config:', error);
    }
  }
}

async function saveConfig(newConfig: any) {
  configCache = newConfig;
  await fs.writeFile(CONFIG_FILE, JSON.stringify(configCache, null, 2), 'utf-8');
}

function isTopLevelTaskFile(filePath: string) {
  return filePath.endsWith('.md') && path.dirname(filePath) === FLUX_DIR;
}

async function loadTask(filePath: string) {
  if (!isTopLevelTaskFile(filePath)) return;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const id = parsed.data.id || path.basename(filePath, '.md');
    tasksCache[id] = {
      ...parsed.data,
      id,
      body: parsed.content,
      _path: filePath
    };
    console.log(`Loaded task: ${id}`);
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error);
  }
}

// Ensure .flux dir exists
async function initDir() {
  try {
    await fs.mkdir(FLUX_DIR, { recursive: true });
  } catch (err) {
    // ignore
  }
  await loadConfig();
}

initDir().then(() => {
  // Initialize File Watcher
  const watcher = chokidar.watch(FLUX_DIR, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.flux';
    },
    persistent: true
  });

  watcher
    .on('add', (filePath) => {
      if (isTopLevelTaskFile(filePath)) loadTask(filePath);
      if (filePath === CONFIG_FILE) loadConfig();
    })
    .on('change', (filePath) => {
      if (isTopLevelTaskFile(filePath)) loadTask(filePath);
      if (filePath === CONFIG_FILE) loadConfig();
    })
    .on('unlink', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        const taskEntry = Object.entries(tasksCache).find(([, task]) => task._path === filePath);
        const id = taskEntry?.[0] || path.basename(filePath, '.md');
        delete tasksCache[id];
        console.log(`Removed task: ${id}`);
      }
    });
});

// API Routes
app.get('/api/tasks', (req, res) => {
  res.json(Object.values(tasksCache));
});

app.get('/api/skill/status', async (req, res) => {
  try {
    const [sourceExists, installedExists] = await Promise.all([
      fs.access(SKILL_SOURCE_PATH).then(() => true).catch(() => false),
      fs.access(WORKSPACE_SKILL_PATH).then(() => true).catch(() => false),
    ]);

    res.json({
      sourcePath: SKILL_SOURCE_PATH,
      installedPath: WORKSPACE_SKILL_PATH,
      sourceExists,
      installed: installedExists,
    });
  } catch (error) {
    console.error('Failed to load skill status:', error);
    res.status(500).json({ error: 'Failed to load skill status' });
  }
});

app.post('/api/skill/install', async (req, res) => {
  try {
    await fs.mkdir(path.dirname(WORKSPACE_SKILL_PATH), { recursive: true });
    await fs.copyFile(SKILL_SOURCE_PATH, WORKSPACE_SKILL_PATH);
    res.json({ success: true, installedPath: WORKSPACE_SKILL_PATH });
  } catch (error) {
    console.error('Failed to install skill:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

// POST new task
app.post('/api/tasks', async (req, res) => {
  const { projectKey, status, author, title, body, ...rest } = req.body;
  const pKey = projectKey || 'FLUX';
  
  // Find next ID
  let maxId = 0;
  Object.keys(tasksCache).forEach(key => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });
  
  const nextId = `${pKey}-${maxId + 1}`;
  const filePath = path.join(FLUX_DIR, `${nextId}.md`);
  
  const frontmatter = {
    id: nextId,
    title: title || 'New Task',
    status: status || 'Todo',
    priority: rest.priority || 'None',
    createdBy: author || 'Unknown',
    updatedBy: author || 'Unknown',
    assignee: 'unassigned',
    tags: [],
    history: [],
    ...rest
  };
  
  try {
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(filePath, fileContent, 'utf-8');
    
    tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
    res.json(tasksCache[nextId]);
  } catch (err) {
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { updatedBy, ...updates } = req.body;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Merge updates
  const { body, _path, id: _id, ...frontmatter } = { ...task, ...updates };
  if (updatedBy) {
    frontmatter.updatedBy = updatedBy;
  }

  try {
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(_path, fileContent, 'utf-8');
    
    // Optimistic update in cache
    tasksCache[id] = { ...frontmatter, body, id, _path };
    res.json(tasksCache[id]);
  } catch (err) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    await fs.unlink(task._path);
    delete tasksCache[id];
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.post('/api/bulk-rename', async (req, res) => {
  const { tags = {}, statuses = {}, users = {}, priorities = {} } = req.body;
  let modifiedCount = 0;

  try {
    for (const id in tasksCache) {
      const task = tasksCache[id];
      let changed = false;
      const { body, _path, id: _id, ...frontmatter } = task;

      // Rename tags
      if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
        const newTags = frontmatter.tags.map((t: string) => tags[t] || t);
        if (JSON.stringify(newTags) !== JSON.stringify(frontmatter.tags)) {
          frontmatter.tags = newTags;
          changed = true;
        }
      }

      // Rename status
      if (frontmatter.status && statuses[frontmatter.status]) {
        frontmatter.status = statuses[frontmatter.status];
        changed = true;
      }

      // Rename users
      if (frontmatter.assignee && users[frontmatter.assignee]) {
        frontmatter.assignee = users[frontmatter.assignee];
        changed = true;
      }
      if (frontmatter.priority && priorities[frontmatter.priority]) {
        frontmatter.priority = priorities[frontmatter.priority];
        changed = true;
      }
      if (frontmatter.author && users[frontmatter.author]) {
        frontmatter.author = users[frontmatter.author];
        changed = true;
      }
      if (frontmatter.updatedBy && users[frontmatter.updatedBy]) {
        frontmatter.updatedBy = users[frontmatter.updatedBy];
        changed = true;
      }
      if (frontmatter.history && Array.isArray(frontmatter.history)) {
        let historyChanged = false;
        frontmatter.history.forEach((h: any) => {
          if (h.user && users[h.user]) {
            h.user = users[h.user];
            historyChanged = true;
          }
          if (h.type === 'status_change') {
            if (h.from && statuses[h.from]) { h.from = statuses[h.from]; historyChanged = true; }
            if (h.to && statuses[h.to]) { h.to = statuses[h.to]; historyChanged = true; }
          }
        });
        if (historyChanged) changed = true;
      }

      if (changed) {
        const fileContent = matter.stringify(body || '', frontmatter);
        await fs.writeFile(_path, fileContent, 'utf-8');
        tasksCache[id] = { ...frontmatter, body, id, _path };
        modifiedCount++;
      }
    }
    res.json({ success: true, modifiedCount });
  } catch (err) {
    console.error('Failed bulk rename:', err);
    res.status(500).json({ error: 'Failed bulk rename' });
  }
});

app.get('/api/config', (req, res) => {
  res.json(configCache);
});

app.put('/api/config', async (req, res) => {
  try {
    await saveConfig(req.body);
    res.json(configCache);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Event Horizon Engine running on port ${PORT}`);
});
