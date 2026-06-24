// FLUX-715: the board card's action cluster is now a thin adapter over the unified ticket-action
// renderer. All status→action logic (launch split-buttons, the Ready Review/Return/Finish cluster,
// template menus) lives in the shared registry + `useTicketActions` hook; the card just renders the
// `card` variant from the controller's shared instance. The launcher / start-prompt portals are
// rendered by <TicketActionsLaunchers> in TaskCard.
import type { TaskCardController } from '../../hooks/useTaskCardController';
import { TicketActionsView } from '../ticket-actions/TicketActions';

export function CardActionButtons({ c }: { c: TaskCardController }) {
  return <TicketActionsView ctl={c.ticketActions} variant="card" onActiveChange={c.setActionMenuActive} />;
}
