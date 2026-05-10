"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const chokidar_1 = __importDefault(require("chokidar"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const gray_matter_1 = __importDefault(require("gray-matter"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const FLUX_DIR = path_1.default.join(__dirname, '../../.flux');
const CONFIG_FILE = path_1.default.join(FLUX_DIR, 'config.json');
let tasksCache = {};
let configCache = {
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
        const data = await promises_1.default.readFile(CONFIG_FILE, 'utf-8');
        const loaded = JSON.parse(data);
        // Migration: Convert string arrays to object arrays
        if (loaded.columns?.length && typeof loaded.columns[0] === 'string')
            loaded.columns = loaded.columns.map((s) => ({ name: s }));
        if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string')
            loaded.hiddenStatuses = loaded.hiddenStatuses.map((s) => ({ name: s }));
        if (loaded.users?.length && typeof loaded.users[0] === 'string')
            loaded.users = loaded.users.map((s) => ({ name: s }));
        if (loaded.tags?.length && typeof loaded.tags[0] === 'string')
            loaded.tags = loaded.tags.map((s) => ({
                name: s,
                color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
            }));
        if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
            loaded.priorities = configCache.priorities;
        }
        if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
            loaded.priorities = loaded.priorities.map((name) => ({
                name,
                icon: 'Equal',
                color: 'text-gray-400'
            }));
        }
        configCache = { ...configCache, ...loaded };
        console.log('Loaded config');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            await saveConfig(configCache);
        }
        else {
            console.error('Failed to load config:', error);
        }
    }
}
async function saveConfig(newConfig) {
    configCache = newConfig;
    await promises_1.default.writeFile(CONFIG_FILE, JSON.stringify(configCache, null, 2), 'utf-8');
}
async function loadTask(filePath) {
    if (!filePath.endsWith('.md'))
        return;
    try {
        const content = await promises_1.default.readFile(filePath, 'utf-8');
        const parsed = (0, gray_matter_1.default)(content);
        const id = parsed.data.id || path_1.default.basename(filePath, '.md');
        tasksCache[id] = {
            ...parsed.data,
            id,
            body: parsed.content,
            _path: filePath
        };
        console.log(`Loaded task: ${id}`);
    }
    catch (error) {
        console.error(`Failed to load ${filePath}:`, error);
    }
}
// Ensure .flux dir exists
async function initDir() {
    try {
        await promises_1.default.mkdir(FLUX_DIR, { recursive: true });
    }
    catch (err) {
        // ignore
    }
    await loadConfig();
}
initDir().then(() => {
    // Initialize File Watcher
    const watcher = chokidar_1.default.watch(FLUX_DIR, {
        ignored: (filePath) => {
            const basename = path_1.default.basename(filePath);
            return basename.startsWith('.') && basename !== '.flux';
        },
        persistent: true
    });
    watcher
        .on('add', (filePath) => {
        if (filePath.endsWith('.md'))
            loadTask(filePath);
        if (filePath === CONFIG_FILE)
            loadConfig();
    })
        .on('change', (filePath) => {
        if (filePath.endsWith('.md'))
            loadTask(filePath);
        if (filePath === CONFIG_FILE)
            loadConfig();
    })
        .on('unlink', (filePath) => {
        if (filePath.endsWith('.md')) {
            const id = path_1.default.basename(filePath, '.md');
            delete tasksCache[id];
            console.log(`Removed task: ${id}`);
        }
    });
});
// API Routes
app.get('/api/tasks', (req, res) => {
    res.json(Object.values(tasksCache));
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
            if (!isNaN(num) && num > maxId)
                maxId = num;
        }
    });
    const nextId = `${pKey}-${maxId + 1}`;
    const filePath = path_1.default.join(FLUX_DIR, `${nextId}.md`);
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
        const fileContent = gray_matter_1.default.stringify(body || '', frontmatter);
        await promises_1.default.writeFile(filePath, fileContent, 'utf-8');
        tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
        res.json(tasksCache[nextId]);
    }
    catch (err) {
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
        const fileContent = gray_matter_1.default.stringify(body || '', frontmatter);
        await promises_1.default.writeFile(_path, fileContent, 'utf-8');
        // Optimistic update in cache
        tasksCache[id] = { ...frontmatter, body, id, _path };
        res.json(tasksCache[id]);
    }
    catch (err) {
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
        await promises_1.default.unlink(task._path);
        delete tasksCache[id];
        res.json({ success: true });
    }
    catch (err) {
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
                const newTags = frontmatter.tags.map((t) => tags[t] || t);
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
                frontmatter.history.forEach((h) => {
                    if (h.user && users[h.user]) {
                        h.user = users[h.user];
                        historyChanged = true;
                    }
                    if (h.type === 'status_change') {
                        if (h.from && statuses[h.from]) {
                            h.from = statuses[h.from];
                            historyChanged = true;
                        }
                        if (h.to && statuses[h.to]) {
                            h.to = statuses[h.to];
                            historyChanged = true;
                        }
                    }
                });
                if (historyChanged)
                    changed = true;
            }
            if (changed) {
                const fileContent = gray_matter_1.default.stringify(body || '', frontmatter);
                await promises_1.default.writeFile(_path, fileContent, 'utf-8');
                tasksCache[id] = { ...frontmatter, body, id, _path };
                modifiedCount++;
            }
        }
        res.json({ success: true, modifiedCount });
    }
    catch (err) {
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
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});
const PORT = process.env.PORT || 3067;
app.listen(PORT, () => {
    console.log(`Event Horizon Engine running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map