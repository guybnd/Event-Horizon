import { Bot, Terminal, Zap, type LucideIcon } from 'lucide-react';
import type { CliFramework } from './types';

export const FRAMEWORK_ICONS: Record<CliFramework, LucideIcon> = {
  claude: Bot,
  gemini: Zap,
  copilot: Terminal,
};
