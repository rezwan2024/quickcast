import { useState } from 'react';
import {
  IconBook2,
  IconCloud,
  IconApps,
  IconKey,
  IconExternalLink,
  IconArrowLeft,
  IconArrowRight,
  IconCopy,
  IconCheck,
  IconInfoCircle,
} from '@tabler/icons-react';
import { Modal, ModalHeader } from '@/components/modal';
import { Button } from '@/components/button';

interface Step {
  icon: typeof IconCloud;
  title: string;
  time: string;
  body: React.ReactNode;
}

function ExternalLinkChip({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-[#3b82f6]/10 px-2 py-1 text-[#3b82f6]"
    >
      <IconExternalLink size={14} stroke={1.75} />
      {children}
    </a>
  );
}

function SubStep({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-[#f5f5f4] px-4 py-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#3b82f6] text-xs font-medium text-white">
        {number}
      </span>
      <p className="text-sm text-[#1a1d24]">{children}</p>
    </div>
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex w-full items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 font-mono text-xs text-[#1a1d24]"
    >
      {value}
      {copied ? (
        <IconCheck size={14} stroke={1.75} className="shrink-0 text-[#10b981]" />
      ) : (
        <IconCopy size={14} stroke={1.75} className="shrink-0 text-[#999]" />
      )}
    </button>
  );
}

function useSteps(): Step[] {
  return [
    {
      icon: IconCloud,
      title: 'Create a Google Cloud project',
      time: 'Free · takes about 2 minutes',
      body: (
        <>
          <SubStep number={1}>
            Sign in to Google Cloud Console with the account you want to use for storage.{' '}
            <ExternalLinkChip href="https://console.cloud.google.com">console.cloud.google.com</ExternalLinkChip>
          </SubStep>
          <SubStep number={2}>
            Click <strong>New Project</strong>, name it "QuickCast" (or anything), click <strong>Create</strong>.
          </SubStep>
        </>
      ),
    },
    {
      icon: IconApps,
      title: 'Enable Google Drive API',
      time: 'Takes about 1 minute',
      body: (
        <>
          <SubStep number={1}>
            Go to <strong>APIs &amp; Services → Library</strong> for your new project.
          </SubStep>
          <SubStep number={2}>
            Search for <strong>Google Drive API</strong> and click <strong>Enable</strong>.
          </SubStep>
        </>
      ),
    },
    {
      icon: IconKey,
      title: 'Configure OAuth consent & credentials',
      time: 'Takes about 3 minutes',
      body: (
        <>
          <SubStep number={1}>
            In the left sidebar, go to <strong>APIs &amp; Services → OAuth consent screen</strong> — this opens
            Google's newer <strong>Google Auth Platform</strong> pages, with its own left sidebar of tabs
            (<strong>Audience</strong>, <strong>Branding</strong>, <strong>Clients</strong>,{' '}
            <strong>Data Access</strong>) used one at a time by the steps below.
          </SubStep>
          <SubStep number={2}>
            First time only: click <strong>Branding</strong> in the left sidebar and fill in an{' '}
            <strong>App name</strong> (e.g. "QuickCast") and your email under <strong>Support email</strong>.
          </SubStep>
          <SubStep number={3}>
            Click <strong>Clients</strong> → <strong>Create client</strong> → application type{' '}
            <strong>Web application</strong> (not "Chrome Extension" — Google blocks the flow this needs for that
            client type).
          </SubStep>
          <SubStep number={4}>
            <span className="block">
              Under <strong>Authorized redirect URIs</strong>, click <strong>Add URI</strong> and paste this exact
              value (based on this extension's ID):
            </span>
            <span className="mt-2 block">
              <CopyChip value={chrome.identity.getRedirectURL()} />
            </span>
          </SubStep>
          <SubStep number={5}>
            Click <strong>Create</strong>, then copy both the <strong>Client ID</strong> and{' '}
            <strong>Client Secret</strong> — you will need both.
          </SubStep>
          <SubStep number={6}>
            Click <strong>Audience</strong> in the left sidebar → scroll to <strong>Test users</strong> → click{' '}
            <strong>Add users</strong> → add the Google account email you want to connect to QuickCast → click{' '}
            <strong>Save</strong>.
          </SubStep>
          <SubStep number={7}>
            <strong>Personal Gmail accounts only:</strong> click <strong>Data Access</strong> in the left sidebar,
            then <strong>Add or remove scopes</strong>, search for <strong>drive.file</strong>, tick{' '}
            <strong>See, edit, create and delete only the specific files you use with this app</strong>, click{' '}
            <strong>Update</strong> in that panel, then click <strong>Save</strong> at the bottom of the Data
            Access page itself to actually apply it. Workspace accounts may not need this step.
          </SubStep>
          <div className="flex items-start gap-2 rounded-lg bg-[#3b82f6]/10 px-3 py-2.5 text-xs text-[#1a1d24]">
            <IconInfoCircle size={16} stroke={1.75} className="mt-0.5 shrink-0 text-[#3b82f6]" />
            Every QuickCast user needs to add their own email under Test users once. This allows access without
            Google verification.
          </div>
        </>
      ),
    },
  ];
}

interface SetupGuideModalProps {
  onClose: () => void;
  onDone: () => void;
}

export function SetupGuideModal({ onClose, onDone }: SetupGuideModalProps) {
  const steps = useSteps();
  const [stepIndex, setStepIndex] = useState(0);
  const isLastStep = stepIndex === steps.length - 1;
  const step = steps[stepIndex];
  const Icon = step.icon;

  return (
    <Modal onClose={onClose} widthClassName="max-w-[460px]">
      <ModalHeader
        icon={<IconBook2 size={20} stroke={1.75} />}
        title="Setup guide"
        onClose={onClose}
        rightSlot={
          <span className="text-sm text-[#999]">
            Step {stepIndex + 1} / {steps.length}
          </span>
        }
      />

      {/* flex-1 (grow to fill whatever space is left between the header and
          footer below) + min-h-0 (a flex child's default min-height is auto,
          which would otherwise ignore Modal's max-h-[90vh] and keep growing
          instead of scrolling) + overflow-y-auto is what actually lets a
          long step (the OAuth-consent one has 6 sub-steps + an info box)
          scroll internally while the header/step-dots/Back-Next footer stay
          fixed on screen. */}
      <div className="flex-1 overflow-y-auto px-5 py-6 text-center min-h-0">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#3b82f6]/10 text-[#3b82f6]">
          <Icon size={28} stroke={1.5} />
        </span>
        <h3 className="mt-4 text-lg font-medium text-[#1a1d24]">{step.title}</h3>
        <p className="mt-1 text-sm text-[#999]">{step.time}</p>

        <div className="mt-5 space-y-3 text-left">{step.body}</div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-[#e5e5e5] px-5 py-4">
        {stepIndex > 0 ? (
          <Button variant="secondary" icon={<IconArrowLeft size={16} stroke={1.75} />} onClick={() => setStepIndex((i) => i - 1)}>
            Back
          </Button>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2">
          {steps.map((_, i) => (
            <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === stepIndex ? 'bg-[#3b82f6]' : 'bg-[#e5e5e5]'}`} />
          ))}
        </div>

        <Button variant="accent" onClick={() => (isLastStep ? onDone() : setStepIndex((i) => i + 1))}>
          {isLastStep ? 'Paste credentials' : 'Next'}
          {!isLastStep && <IconArrowRight size={16} stroke={1.75} />}
        </Button>
      </div>
    </Modal>
  );
}
