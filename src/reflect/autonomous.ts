// reflect/autonomous.ts

export const INTERVAL = 1800;
export const ONCE = false;

export function check(): string {
  return "[AUTO] User has been away for over 30 minutes. As an autonomous agent, please read the autonomous SOP and execute automated tasks.";
}
