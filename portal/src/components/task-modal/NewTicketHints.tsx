import { useEffect, useState } from 'react';

// FLUX-1592: short, rotating "how to write a good ticket" hints shown as the empty-state
// placeholder on the compact create surface's Description field — purely presentational.
const NEW_TICKET_TIPS = [
  'Tip: describe the problem before the solution — future you (or an agent) needs the "why".',
  'Tip: paste or drop a screenshot right here — it uploads and links automatically.',
  'Tip: one clear acceptance criterion beats five vague ones.',
  'Tip: link related tickets or PRs so context isn’t lost.',
  'Tip: a tag or two now makes the board filterable later.',
  'Tip: small, focused tickets get picked up — and finished — faster than sprawling ones.',
];

const ROTATE_INTERVAL_MS = 9000;
const FADE_MS = 400;

export function NewTicketHints() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let fadeTimeout: ReturnType<typeof setTimeout> | undefined;
    const intervalId = setInterval(() => {
      setVisible(false);
      fadeTimeout = setTimeout(() => {
        setIndex((current) => (current + 1) % NEW_TICKET_TIPS.length);
        setVisible(true);
      }, FADE_MS);
    }, ROTATE_INTERVAL_MS);
    return () => {
      clearInterval(intervalId);
      if (fadeTimeout) clearTimeout(fadeTimeout);
    };
  }, []);

  return (
    <p
      className="text-sm italic text-gray-400 transition-opacity duration-300 dark:text-gray-500"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {NEW_TICKET_TIPS[index]}
    </p>
  );
}
