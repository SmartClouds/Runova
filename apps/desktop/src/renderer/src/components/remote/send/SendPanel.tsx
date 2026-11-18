import { Notice } from '@/components/pageKit';
import { useFileSend } from '@/stores/fileSendStore';
import { RequireRemoteSignIn } from '../RequireRemoteSignIn';
import { ReceiveSettingsCard } from './ReceiveSettingsCard';
import { SendComposer } from './SendComposer';

/** The Remote page's Send files tab (E112): sending first, then what comes to this computer. */
export function SendPanel(): React.JSX.Element {
  const state = useFileSend();
  return (
    <RequireRemoteSignIn
      title="Sign in to send files"
      text="Sending files to your other computers and your teammates needs a Runova account."
    >
      <div className="flex flex-col gap-2">
        {state.status === 'offline' || state.status === 'error' ? (
          <Notice tone="warning">
            Runova Anywhere is not connected to the website right now, so nothing can be sent or
            received. It keeps trying on its own.
          </Notice>
        ) : null}
        <SendComposer />
        <ReceiveSettingsCard />
      </div>
    </RequireRemoteSignIn>
  );
}
