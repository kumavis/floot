import { useEffect, useState } from "react";

interface Props {
  value: string;
  onChange: (deviceId: string) => void;
}

export function MicSelect({ value, onChange }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setDevices(list.filter((d) => d.kind === "audioinput"));
        setDenied(false);
      } catch {
        if (cancelled) return;
        setDenied(true);
      }
    }

    load();
    const onChange = () => {
      load();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, []);

  if (denied) {
    return (
      <select className="mic-select" disabled>
        <option>No mic access</option>
      </select>
    );
  }

  return (
    <select
      className="mic-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {devices.length === 0 ? (
        <option value="">Loading devices...</option>
      ) : (
        devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `Microphone ${i + 1}`}
          </option>
        ))
      )}
    </select>
  );
}
