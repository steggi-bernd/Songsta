/**
 * A device was handed a song that goes through this computer and nobody came for it: Windows' firewall, most likely.
 * Asked once per run; after a yes the songs on their way are handed over again.
 */
import { useUI } from "../stores/ui";
import { T } from "./i18n";

let asked = false;

export async function offerFirewall(name: string): Promise<void> {
  const bridge = window.bytune;
  if (asked || !bridge) return;
  if (!(await bridge.firewallMatters()) || (await bridge.firewallHasRule())) return;
  asked = true;
  useUI.getState().openDialog({
    title: T("Windows is keeping {name} out", { name }),
    body: T("{name} can't fetch the song from this computer because the firewall stops it. Songsta can add a rule for devices on your own network. Windows asks you for the OK.", { name }),
    confirmLabel: T("Allow"),
    cancelLabel: T("Not now"),
    onConfirm: () => {
      void bridge.firewallAllow().then((done) => {
        const { toast } = useUI.getState();
        if (done) {
          toast(T("Allowed. {name} gets the song again.", { name }));
          void bridge.castAgain();
        } else {
          toast(T("The firewall stays as it was, so {name} can't reach local files.", { name }), "error");
        }
      });
    },
  });
}

/** For the tests: a new run. */
export function resetFirewallOffer(): void {
  asked = false;
}
