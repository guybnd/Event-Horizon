import { memo } from 'react';
import { Bot } from 'lucide-react';
import type { CliSessionSummary } from '../types';
import { FRAMEWORK_ICONS } from '../constants';
import {
  type SessionGroup,
  type TopologyShape,
  aggregateGroup,
  topologyShape,
  patternLabel,
  normalizeRoleLabel,
  isActiveSession,
  statusDotColor,
} from '../orchestration';

interface GlyphProps {
  shape: TopologyShape;
  className?: string;
}

/** Compact SVG glyph conveying the orchestration topology shape. */
export const TopologyGlyph = memo(function TopologyGlyph({ shape, className = 'h-3.5 w-3.5' }: GlyphProps) {
  const stroke = 'currentColor';
  const common = { fill: 'none', stroke, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (shape) {
    case 'pipeline':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <circle cx="4" cy="12" r="2.2" {...common} />
          <circle cx="12" cy="12" r="2.2" {...common} />
          <circle cx="20" cy="12" r="2.2" {...common} />
          <path d="M6.2 12h3.6M14.2 12h3.6" {...common} />
        </svg>
      );
    case 'tree':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <circle cx="12" cy="5" r="2.2" {...common} />
          <circle cx="12" cy="18" r="2.2" {...common} />
          <path d="M12 7.2v8.6" {...common} />
        </svg>
      );
    case 'fan':
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <circle cx="4" cy="6" r="2" {...common} />
          <circle cx="4" cy="12" r="2" {...common} />
          <circle cx="4" cy="18" r="2" {...common} />
          <circle cx="20" cy="12" r="2.2" {...common} />
          <path d="M6 6.6 17.9 11M6 12h11.8M6 17.4 17.9 13" {...common} />
        </svg>
      );
    case 'swarm':
    default:
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden>
          <circle cx="6" cy="7" r="2" {...common} />
          <circle cx="18" cy="7" r="2" {...common} />
          <circle cx="6" cy="17" r="2" {...common} />
          <circle cx="18" cy="17" r="2" {...common} />
        </svg>
      );
  }
});

function StatusDot({ session }: { session: CliSessionSummary }) {
  const color = statusDotColor(session.status);
  const pulse = isActiveSession(session) && session.status !== 'waiting-input' ? 'animate-pulse' : '';
  return <span className={`inline-block h-2 w-2 rounded-full bg-current ${color} ${pulse}`} aria-hidden />;
}

interface TopologyProps {
  group: SessionGroup;
  variant?: 'glyph' | 'map';
  className?: string;
}

/**
 * Shared orchestration mini-map. `glyph` renders a tiny shape + label for cards;
 * `map` renders the per-agent node layout used by the modal Run View and launcher.
 */
export const OrchestrationTopology = memo(function OrchestrationTopology({ group, variant = 'map', className = '' }: TopologyProps) {
  const shape = topologyShape(group.groupType, group.groupVariant);
  const agg = aggregateGroup(group);
  const label = patternLabel(group.groupType, group.groupVariant);

  if (variant === 'glyph') {
    return (
      <span className={`inline-flex items-center gap-1 text-gray-500 dark:text-gray-400 ${className}`}>
        <TopologyGlyph shape={shape} />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </span>
    );
  }

  const renderNode = (s: CliSessionSummary, isLead = false) => {
    const Icon = FRAMEWORK_ICONS[s.framework] || Bot;
    const role = normalizeRoleLabel(s.role) || (isLead ? 'lead' : s.framework);
    return (
      <div
        key={s.id}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 ${
          isLead
            ? 'border-violet-300 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10'
            : 'border-gray-200 bg-white dark:border-white/10 dark:bg-white/5'
        }`}
        title={`${role} — ${s.status}`}
      >
        <Icon className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
        <span className="max-w-[120px] truncate text-[11px] font-medium text-gray-800 dark:text-gray-200">{role}</span>
        <StatusDot session={s} />
      </div>
    );
  };

  const renderPendingCombiner = () => (
    <div
      key="pending-combiner"
      className="flex items-center gap-1.5 rounded-lg border border-dashed border-violet-300 bg-violet-50/50 px-2 py-1 opacity-60 dark:border-violet-500/30 dark:bg-violet-500/5"
      title="Combiner — pending (waiting for workers)"
    >
      <Bot className="h-3.5 w-3.5 text-violet-400 dark:text-violet-500" />
      <span className="max-w-[120px] truncate text-[11px] font-medium italic text-violet-500 dark:text-violet-400">combiner</span>
      <span className="inline-block h-2 w-2 rounded-full bg-amber-400 dark:bg-amber-500" aria-hidden />
    </div>
  );

  // Show a ghost combiner node when the group expects a lead but none has launched yet.
  const hasPendingCombiner = (shape === 'fan' || shape === 'tree') && !agg.lead && group.groupVariant === 'combiner';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-gray-400"><TopologyGlyph shape={shape} className="h-4 w-4" /></span>
      {shape === 'fan' || shape === 'tree' ? (
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {agg.lead && renderNode(agg.lead, true)}
          {!agg.lead && hasPendingCombiner && renderPendingCombiner()}
          {(agg.lead || hasPendingCombiner) && <span className="text-gray-300 dark:text-gray-600">→</span>}
          <div className="flex flex-wrap gap-1.5">{agg.steps.map(s => renderNode(s))}</div>
        </div>
      ) : shape === 'pipeline' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {group.sessions.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1.5">
              {renderNode(s)}
              {i < group.sessions.length - 1 && <span className="text-gray-300 dark:text-gray-600">→</span>}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">{group.sessions.map(s => renderNode(s))}</div>
      )}
    </div>
  );
});
