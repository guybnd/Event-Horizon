export type CommUserStyle = 'concise' | 'detailed' | 'custom' | 'off';

interface CommunicationStyleSectionProps {
  userStyle: CommUserStyle;
  setUserStyle: (v: CommUserStyle) => void;
  customText: string;
  setCustomText: (v: string) => void;
  interAgent: boolean;
  setInterAgent: (v: boolean) => void;
}

const STYLE_DESCRIPTIONS: Record<CommUserStyle, string> = {
  concise: 'Lead with the outcome, plain language, bold the key phrases, no filler.',
  detailed: 'Still outcome-first, but walks through the reasoning and glosses jargon — good while learning the codebase.',
  custom: 'Your own writing rules, injected verbatim under the user-facing style heading.',
  off: 'No user-facing style block is injected.',
};

/** FLUX-1502: two-axis communication-style setting. The user-facing style is taste (selectable);
 *  the inter-agent block is a fixed protocol (on/off only) — a style menu there would invite
 *  degradation of agent-to-agent handoffs. */
export function CommunicationStyleSection({
  userStyle,
  setUserStyle,
  customText,
  setCustomText,
  interAgent,
  setInterAgent,
}: CommunicationStyleSectionProps) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Communication Style</h3>
      <p className="text-xs text-gray-500 mb-4">
        Writing rules injected into every agent session&apos;s prompt. How agents write <em>to you</em> is a
        selectable style; how they write <em>to each other</em> is a fixed protocol.
      </p>

      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
          Style toward you
        </label>
        <select
          value={userStyle}
          onChange={(e) => setUserStyle(e.target.value as CommUserStyle)}
          className="w-48 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
        >
          <option value="concise">Concise (default)</option>
          <option value="detailed">Detailed</option>
          <option value="custom">Custom</option>
          <option value="off">Off</option>
        </select>
        <p className="text-xs text-gray-500 mt-1">{STYLE_DESCRIPTIONS[userStyle]}</p>
      </div>

      {userStyle === 'custom' && (
        <div className="mb-4">
          <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Custom style rules
          </label>
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            rows={4}
            placeholder={'e.g. Answer in bullet points only. Always include a one-line summary at the top. Address me as…'}
            className="w-full max-w-xl rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630] dark:text-gray-100"
          />
          <p className="text-xs text-gray-500 mt-1">Left empty, sessions fall back to the concise style.</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t border-gray-200 pt-4 dark:border-white/10">
        <div>
          <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5" onClick={() => setInterAgent(!interAgent)} style={{ cursor: 'pointer' }}>
            Inter-agent protocol
          </span>
          <span className="text-xs text-gray-500 text-balance pr-4">
            Fixed contract for agent-to-agent handoffs and delegations: self-contained references, action
            first, decisions carried with their rationale, explicit delegation scopes. Not a style — turn
            off only to save prompt tokens.
          </span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={interAgent}
            onChange={(e) => setInterAgent(e.target.checked)}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
        </label>
      </div>
    </div>
  );
}
