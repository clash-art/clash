
import { motion, AnimatePresence } from 'framer-motion';
import { presenceLabel, type PresenceClient } from '@clash/shared-types';
import { colorForUserId } from '@clash/web-ui/hooks/usePresenceAwareness';
import { AvatarFallback, AvatarRoot } from './ui/avatar';
import { PresenceAvatar } from './PresenceAvatar';
import { Tooltip } from './ui/tooltip';

interface PresenceBarProps {
  /** Other connections, including the same user's other sessions. */
  clients: PresenceClient[];
}

export default function PresenceBar({ clients }: PresenceBarProps) {
  if (clients.length === 0) return null;

  const maxVisible = 5;
  const visible = clients.slice(0, maxVisible);
  const overflow = clients.length - maxVisible;

  return (
    <div className="flex items-center -space-x-2">
      <AnimatePresence mode="popLayout">
        {visible.map((client) => (
          <motion.div
            key={client.id}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          >
            <Tooltip label={presenceLabel(client)}>
              <span className="inline-flex">
                <PresenceAvatar
                  name={client.name}
                  kind={client.kind}
                  avatar={client.avatar}
                  color={colorForUserId(client.userId)}
                />
              </span>
            </Tooltip>
          </motion.div>
        ))}
      </AnimatePresence>

      {overflow > 0 && (
        <AvatarRoot className="border-2 border-warm-surface shadow-sm" aria-label={`${overflow} more participants`}>
          <AvatarFallback className="bg-warm-muted text-xs font-bold text-slate-700 dark:text-slate-200">
            +{overflow}
          </AvatarFallback>
        </AvatarRoot>
      )}
    </div>
  );
}
