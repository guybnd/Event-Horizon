import { getDefaultStatusColor } from '../statusStyles';

export function StatusBadge({ status, colorClass, className = '' }: { status: string; colorClass?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 ${colorClass || getDefaultStatusColor(status)} ${className}`}>
      {status}
    </span>
  );
}