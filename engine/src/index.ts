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

let tasksCache: Record<string, any> = {};
let configCache: any = {
  columns: ["Todo", "In Progress", "Done"],
  hiddenStatuses: ["Backlog"]
};

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    configCache = JSON.parse(data);
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

async function loadTask(filePath: string) {
  if (!filePath.endsWith('.md')) return;
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
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
  });

  watcher
    .on('add', (filePath) => {
      if (filePath.endsWith('.md')) loadTask(filePath);
      if (filePath === CONFIG_FILE) loadConfig();
    })
    .on('change', (filePath) => {
      if (filePath.endsWith('.md')) loadTask(filePath);
      if (filePath === CONFIG_FILE) loadConfig();
    })
    .on('unlink', (filePath) => {
      if (filePath.endsWith('.md')) {
        const id = path.basename(filePath, '.md');
        delete tasksCache[id];
        console.log(`Removed task: ${id}`);
      }
    });
});

// API Routes
app.get('/api/tasks', (req, res) => {
  res.json(Object.values(tasksCache));
});

app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Separate body and internal fields from frontmatter
  const { body, _path, id: _id, ...frontmatter } = { ...task, ...updates };

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
