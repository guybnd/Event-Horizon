import { Bot, Terminal, Zap } from 'lucide-react';
import type { CliFramework } from './types';

export const FRAMEWORK_ICONS: Record<CliFramework, React.ComponentType<any>> = {
  claude: Bot,
  gemini: Zap,
  copilot: Terminal,
};
