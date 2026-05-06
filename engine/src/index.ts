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
let tasksCache: Record<string, any> = {};

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
}

initDir().then(() => {
  // Initialize File Watcher
  const watcher = chokidar.watch(FLUX_DIR, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
  });

  watcher
    .on('add', loadTask)
    .on('change', loadTask)
    .on('unlink', (filePath) => {
      const id = path.basename(filePath, '.md');
      delete tasksCache[id];
      console.log(`Removed task: ${id}`);
    });
});

// API Routes
app.get('/api/tasks', (req, res) => {
  res.json(Object.values(tasksCache));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Event Horizon Engine running on port ${PORT}`);
});
