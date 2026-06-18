import { AlertCircle, ChevronDown, ChevronUp, Equal } from 'lucide-react';
import type { Config } from '../../types';

export function getPriorityIcon(priorityName: string, config: Config | null, className = 'h-4 w-4') {
  const priority = config?.priorities.find((item) => item.name === priorityName);
  const color = priority?.color || 'text-gray-400';
  switch (priority?.icon) {
    case 'AlertCircle':
      return <AlertCircle className={`${className} ${color}`} />;
    case 'ChevronUp':
      return <ChevronUp className={`${className} ${color}`} />;
    case 'ChevronDown':
      return <ChevronDown className={`${className} ${color}`} />;
    case 'Equal':
      return <Equal className={`${className} ${color}`} />;
    default:
      return <Equal className={`${className} text-gray-400`} />;
  }
}
