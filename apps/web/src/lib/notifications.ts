import { type ScannerAlert } from "@tsx-scanner/contracts";

export function playAlertSound(
  context: AudioContext,
  type: ScannerAlert["type"],
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(
    type === "READY" ? 880 : 330,
    context.currentTime,
  );
  if (type === "READY")
    oscillator.frequency.setValueAtTime(1174, context.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.3);
}

export function allNotificationsSupported(): boolean {
  return "Notification" in window;
}
