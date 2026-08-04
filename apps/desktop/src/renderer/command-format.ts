import type { CommandSpec } from '@qagent/contracts';

export function formatCommand(command: CommandSpec): string {
  const environment = Object.keys(command.env).sort();
  const prefix =
    environment.length > 0 ? `${environment.map((name) => `${name}=<configured>`).join(' ')} ` : '';
  const executable = [command.executable, ...command.args]
    .map((part) => JSON.stringify(part))
    .join(' ');
  return `${prefix}${executable}  [cwd ${command.cwd}]`;
}
