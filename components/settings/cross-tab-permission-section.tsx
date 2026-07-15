import { useEffect, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Toggle } from '@/components/toggle';
import { removeCrossTabPermission, requestCrossTabPermission } from '@/lib/cross-tab-permission';
import {
  getFollowWebcamAcrossTabs,
  getFollowWidgetAcrossTabs,
  setFollowWebcamAcrossTabs,
  setFollowWidgetAcrossTabs,
} from '@/lib/preferences';

interface CrossTabPermissionSectionProps {
  onError: (message: string) => void;
}

export function CrossTabPermissionSection({ onError }: CrossTabPermissionSectionProps) {
  const [followWidget, setFollowWidget] = useState(true);
  const [followWebcam, setFollowWebcam] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getFollowWidgetAcrossTabs(), getFollowWebcamAcrossTabs()]).then(([widget, webcam]) => {
      setFollowWidget(widget);
      setFollowWebcam(webcam);
      setLoading(false);
    });
  }, []);

  // Both toggles share the same underlying <all_urls> grant (there's no
  // narrower permission for "whatever tab becomes active next" — see
  // lib/cross-tab-permission.ts). Requesting it is a no-op that resolves
  // immediately, with no prompt, if it's already granted, so it's safe to
  // call every time either toggle turns on. Only revoked once BOTH are off —
  // either one alone still needs it.
  async function handleWidgetToggle(next: boolean) {
    if (next) {
      const granted = await requestCrossTabPermission();
      if (!granted) return;
      await setFollowWidgetAcrossTabs(true);
      setFollowWidget(true);
    } else {
      await setFollowWidgetAcrossTabs(false);
      setFollowWidget(false);
      if (!followWebcam) await removeCrossTabPermission();
    }
  }

  async function handleWebcamToggle(next: boolean) {
    if (next) {
      const granted = await requestCrossTabPermission();
      if (!granted) return;
      await setFollowWebcamAcrossTabs(true);
      setFollowWebcam(true);
    } else {
      await setFollowWebcamAcrossTabs(false);
      setFollowWebcam(false);
      if (!followWidget) await removeCrossTabPermission();
    }
  }

  if (loading) return null;

  return (
    <section className="mt-8">
      <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Follow recording across tabs</span>
      <div className="mt-2 space-y-2">
        <div className="flex items-start justify-between gap-3 rounded-xl border border-[#e5e5e5] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-[#1a1d24]">Show recording widget on any tab</p>
            <p className="mt-0.5 text-xs text-[#666]">
              On by default. Chrome only lets it appear on the tab you started recording on unless this is on — then
              the timer widget follows you to every tab you switch to during recording.
            </p>
          </div>
          <Toggle
            checked={followWidget}
            onChange={(next) =>
              void handleWidgetToggle(next).catch((err) => onError(err instanceof Error ? err.message : 'Failed to update the setting'))
            }
          />
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-[#e5e5e5] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-[#1a1d24]">Show webcam bubble on any tab</p>
            <p className="mt-0.5 text-xs text-[#666]">
              On by default. When on, the webcam bubble moves to whichever tab is active (never open in more than
              one at once). When off, it only shows on the tab you started recording on.
            </p>
          </div>
          <Toggle
            checked={followWebcam}
            onChange={(next) =>
              void handleWebcamToggle(next).catch((err) => onError(err instanceof Error ? err.message : 'Failed to update the setting'))
            }
          />
        </div>
      </div>
      {(followWidget || followWebcam) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-[#f59e0b]/10 px-3 py-2.5 text-xs text-[#92620a]">
          <IconAlertTriangle size={16} stroke={1.75} className="mt-0.5 shrink-0" />
          QuickCast can now read and change data on every site you visit. Turn both of these off any time to revoke
          it — QuickCast still never sends any of that data anywhere.
        </div>
      )}
    </section>
  );
}
