import { Command, CommandExecutor } from '@effect/platform';
import { describe, expect, layer } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { afterEach, vi } from 'vitest';
import { CommandRunner } from 'src/services/command-runner';
import { SetupSkillInstaller } from 'src/services/setup-skill-installer';
import { cli, MockConsole, TestLive } from 'test/__utils__';

const commandParts = (command: Command.Command): ReadonlyArray<string> => {
  const flattened = Command.flatten(command);
  const first = flattened[0];
  return [first.command, ...first.args];
};

const makeRunner = (
  respond: (parts: ReadonlyArray<string>) => {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  },
  onRun: (parts: ReadonlyArray<string>) => void = () => undefined
) =>
  new CommandRunner({
    run: command =>
      Effect.sync(() => {
        onRun(commandParts(command));
        return CommandExecutor.ExitCode(0);
      }),
    capture: command => {
      const result = respond(commandParts(command));
      return Effect.succeed({
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    },
  });

describe('CLI: composio setup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  const humanCommands: string[][] = [];
  const humanRunner = makeRunner(parts => {
    humanCommands.push([...parts]);
    if (parts.join(' ') === 'claude --version') return { stdout: '2.1.0' };
    if (parts.join(' ') === 'claude plugin marketplace list --json') {
      return { stdout: '[]' };
    }
    if (parts.join(' ') === 'claude plugin list --json') return { stdout: '[]' };
    return {};
  });

  layer(TestLive({ fixture: 'user-config-example', commandRunner: humanRunner }))(
    'human identity',
    it => {
      it.scoped('registers and installs the Claude plugin with exact native commands', () =>
        Effect.gen(function* () {
          humanCommands.length = 0;
          yield* cli(['setup', '--target', 'claude', '--yes']);

          expect(humanCommands).toContainEqual([
            'claude',
            'plugin',
            'marketplace',
            'add',
            'ComposioHQ/composio-plugin-cc',
            '--scope',
            'user',
          ]);
          expect(humanCommands).toContainEqual([
            'claude',
            'plugin',
            'install',
            'composio@composio',
            '--scope',
            'user',
          ]);

          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain('Configured and enabled the Composio plugin for claude');
          expect(output).toContain('"success":true');
        })
      );
    }
  );

  const freshHumanLoginCommands: string[][] = [];
  const freshHumanRunner = makeRunner(
    parts => {
      freshHumanLoginCommands.push([...parts]);
      if (parts.join(' ') === 'claude --version') return { stdout: '2.1.0' };
      if (parts.join(' ') === 'claude plugin marketplace list --json') return { stdout: '[]' };
      if (parts.join(' ') === 'claude plugin list --json') return { stdout: '[]' };
      return {};
    },
    parts => freshHumanLoginCommands.push([...parts])
  );
  const freshHumanSkillInstaller = new SetupSkillInstaller({
    isClaudeSkillInstalled: Effect.succeed(false),
    ensureClaudeSkill: Effect.succeed(true),
  });

  layer(
    TestLive({
      commandRunner: freshHumanRunner,
      setupSkillInstaller: freshHumanSkillInstaller,
    })
  )('fresh human identity', it => {
    it.scoped('delegates to existing human login without requiring a second command', () =>
      Effect.gen(function* () {
        freshHumanLoginCommands.length = 0;
        yield* cli(['setup', '--target', 'claude', '--yes']);

        expect(freshHumanLoginCommands).toContainEqual([
          'composio',
          'login',
          '--no-skill-install',
          '--yes',
        ]);
        const output = (yield* MockConsole.getLines()).join('\n');
        expect(output).toContain('Composio identity is ready');
        expect(output).toContain('"identity":"human"');
        expect(output).toContain('"success":true');
      })
    );
  });

  const codexCommands: string[][] = [];
  const codexInstalledRunner = makeRunner(parts => {
    codexCommands.push([...parts]);
    if (parts.join(' ') === 'codex --version') return { stdout: 'codex-cli 0.144.1' };
    if (parts.join(' ') === 'codex plugin marketplace list --json') {
      return {
        stdout: JSON.stringify({
          marketplaces: [
            {
              name: 'composio',
              marketplaceSource: {
                sourceType: 'git',
                source: 'https://github.com/COMPOSIOHQ/composio-plugin-openai.git/',
              },
            },
          ],
        }),
      };
    }
    if (parts.join(' ') === 'codex plugin list --json') {
      return {
        stdout: JSON.stringify({
          installed: [{ pluginId: 'composio@composio', installed: true, enabled: true }],
        }),
      };
    }
    return {};
  });

  layer(TestLive({ fixture: 'user-config-example', commandRunner: codexInstalledRunner }))(
    'existing Codex install',
    it => {
      it.scoped('is idempotent when the Codex marketplace and plugin are already installed', () =>
        Effect.gen(function* () {
          codexCommands.length = 0;
          yield* cli(['setup', '--target', 'codex', '--yes']);

          expect(codexCommands).not.toContainEqual([
            'codex',
            'plugin',
            'marketplace',
            'add',
            'ComposioHQ/composio-plugin-openai',
            '--json',
          ]);
          expect(codexCommands).not.toContainEqual([
            'codex',
            'plugin',
            'add',
            'composio@composio',
            '--json',
          ]);

          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain('already installed and enabled');
          expect(output).toContain('"changed":false');
          expect(output).toContain('"cli_skill_ready":true');
          expect(output).toContain('"success":true');
          expect(output).not.toContain('uak_');
          expect(process.exitCode).toBeUndefined();
        })
      );
    }
  );

  const disabledClaudeCommands: string[][] = [];
  const disabledClaudeRunner = makeRunner(parts => {
    disabledClaudeCommands.push([...parts]);
    if (parts.join(' ') === 'claude --version') return { stdout: '2.1.0' };
    if (parts.join(' ') === 'claude plugin marketplace list --json') {
      return {
        stdout: JSON.stringify([
          {
            name: 'composio',
            source: { source: 'github', repo: 'ComposioHQ/composio-plugin-cc' },
          },
        ]),
      };
    }
    if (parts.join(' ') === 'claude plugin list --json') {
      return {
        stdout: JSON.stringify([{ id: 'composio@composio', installed: true, enabled: false }]),
      };
    }
    return {};
  });

  layer(TestLive({ fixture: 'user-config-example', commandRunner: disabledClaudeRunner }))(
    'disabled Claude plugin',
    it => {
      it.scoped('repairs a disabled Claude plugin with the native enable command', () =>
        Effect.gen(function* () {
          disabledClaudeCommands.length = 0;
          yield* cli(['setup', '--target', 'claude', '--yes']);

          expect(disabledClaudeCommands).toContainEqual([
            'claude',
            'plugin',
            'enable',
            'composio@composio',
          ]);
          expect(disabledClaudeCommands).not.toContainEqual([
            'claude',
            'plugin',
            'install',
            'composio@composio',
            '--scope',
            'user',
          ]);
          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain('"plugin_installed":true');
          expect(output).toContain('"plugin_enabled":true');
        })
      );

      it.scoped('reports a disabled plugin as not enabled in machine status', () =>
        Effect.gen(function* () {
          disabledClaudeCommands.length = 0;
          yield* cli(['setup', 'status', '--json']);

          const lines = yield* MockConsole.getLines();
          const jsonLine = lines.filter(line => line.startsWith('{')).at(-1);
          const status = JSON.parse(jsonLine ?? '{}') as {
            targets?: Array<Record<string, unknown>>;
          };
          expect(status.targets?.find(item => item.target === 'claude')).toMatchObject({
            plugin_installed: true,
            plugin_enabled: false,
          });
          expect(disabledClaudeCommands).not.toContainEqual([
            'claude',
            'plugin',
            'enable',
            'composio@composio',
          ]);
        })
      );
    }
  );

  const disabledCodexCommands: string[][] = [];
  const disabledCodexRunner = makeRunner(parts => {
    disabledCodexCommands.push([...parts]);
    if (parts.join(' ') === 'codex --version') return { stdout: 'codex-cli 0.144.1' };
    if (parts.join(' ') === 'codex plugin marketplace list --json') {
      return {
        stdout: JSON.stringify({
          marketplaces: [
            {
              name: 'composio',
              marketplaceSource: {
                sourceType: 'git',
                source: 'ComposioHQ/composio-plugin-openai',
              },
            },
          ],
        }),
      };
    }
    if (parts.join(' ') === 'codex plugin list --json') {
      return {
        stdout: JSON.stringify({
          installed: [{ pluginId: 'composio@composio', installed: true, enabled: false }],
        }),
      };
    }
    return {};
  });

  layer(TestLive({ fixture: 'user-config-example', commandRunner: disabledCodexRunner }))(
    'disabled Codex plugin',
    it => {
      it.scoped('repairs a disabled Codex plugin through its native add path', () =>
        Effect.gen(function* () {
          disabledCodexCommands.length = 0;
          yield* cli(['setup', '--target', 'codex', '--yes']);

          expect(disabledCodexCommands).toContainEqual([
            'codex',
            'plugin',
            'add',
            'composio@composio',
            '--json',
          ]);
          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain('"plugin_installed":true');
          expect(output).toContain('"plugin_enabled":true');
          expect(output).toContain('"success":true');
        })
      );
    }
  );

  const codexFreshCommands: string[][] = [];
  const codexFreshRunner = makeRunner(parts => {
    codexFreshCommands.push([...parts]);
    if (parts.join(' ') === 'codex --version') return { stdout: 'codex-cli 0.144.1' };
    if (parts.join(' ') === 'codex plugin marketplace list --json') {
      return { stdout: JSON.stringify({ marketplaces: [] }) };
    }
    if (parts.join(' ') === 'codex plugin list --json') {
      return { stdout: JSON.stringify({ installed: [], available: [] }) };
    }
    return {};
  });
  const codexBundledSkillInstaller = new SetupSkillInstaller({
    isClaudeSkillInstalled: Effect.die(
      new Error('Codex setup must not inspect the standalone Claude skill')
    ),
    ensureClaudeSkill: Effect.die(
      new Error('Codex setup must not install a redundant global CLI skill')
    ),
  });

  layer(
    TestLive({
      fixture: 'user-config-example',
      commandRunner: codexFreshRunner,
      setupSkillInstaller: codexBundledSkillInstaller,
    })
  )('fresh Codex install', it => {
    it.scoped('uses the planned OpenAI marketplace and exact Codex commands', () =>
      Effect.gen(function* () {
        codexFreshCommands.length = 0;
        yield* cli(['setup', '--target', 'codex', '--yes']);

        expect(codexFreshCommands).toContainEqual([
          'codex',
          'plugin',
          'marketplace',
          'add',
          'ComposioHQ/composio-plugin-openai',
          '--json',
        ]);
        expect(codexFreshCommands).toContainEqual([
          'codex',
          'plugin',
          'add',
          'composio@composio',
          '--json',
        ]);
        const output = (yield* MockConsole.getLines()).join('\n');
        expect(output).toContain('"cli_skill_ready":true');
        expect(output).toContain('"success":true');
      })
    );
  });

  const agentResponse = {
    status: 'READY',
    slug: 'setup-agent',
    email: 'setup-agent@agent.composio.ai',
    composio_agent_key: 'cak_setup_agent',
    composio: {
      member_id: 'mem_agent',
      org_id: 'org_agent',
      project_id: 'proj_agent',
      user_api_key: 'uak_agent',
    },
  };

  let agentSkillInstalled = false;
  const agentSkillInstaller = new SetupSkillInstaller({
    isClaudeSkillInstalled: Effect.succeed(false),
    ensureClaudeSkill: Effect.sync(() => {
      agentSkillInstalled = true;
      return true;
    }),
  });

  layer(TestLive({ commandRunner: humanRunner, setupSkillInstaller: agentSkillInstaller }))(
    'agent identity',
    it => {
      it.scoped('provisions and logs in an agent identity without invoking human login', () =>
        Effect.gen(function* () {
          humanCommands.length = 0;
          agentSkillInstalled = false;
          vi.spyOn(globalThis, 'fetch').mockImplementation(async (requestInput, init) => {
            const url =
              typeof requestInput === 'string'
                ? requestInput
                : requestInput instanceof URL
                  ? requestInput.toString()
                  : requestInput.url;
            if (url.includes('/api/signup')) {
              expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
              return new Response(JSON.stringify(agentResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          });

          yield* cli(['setup', '--agent', '--target', 'all', '--yes']);

          expect(humanCommands.some(parts => parts[0] === 'composio' && parts[1] === 'login')).toBe(
            false
          );
          expect(agentSkillInstalled).toBe(true);
          expect(humanCommands).toContainEqual([
            'codex',
            'plugin',
            'marketplace',
            'add',
            'ComposioHQ/composio-plugin-openai',
            '--json',
          ]);
          expect(humanCommands).toContainEqual([
            'codex',
            'plugin',
            'add',
            'composio@composio',
            '--json',
          ]);
          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain('Composio agent identity is ready');
          expect(output).toContain('Installed the composio-cli skill for Claude Code');
          expect(output).toContain('The Codex plugin includes the composio-cli skill');
          expect(output).toContain('"identity":"agent"');
          expect(output).toContain('"success":true');
        })
      );
    }
  );

  const unavailableRunner = makeRunner(() => ({ exitCode: 127, stderr: 'not found' }));
  layer(TestLive({ commandRunner: unavailableRunner }))('status', it => {
    it.scoped('prints machine-readable status without installing anything', () =>
      Effect.gen(function* () {
        yield* cli(['setup', 'status', '--json']);
        const lines = yield* MockConsole.getLines();
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
          authenticated: false,
          identity: null,
          targets: [
            { target: 'claude', available: false, cli_skill_ready: false },
            { target: 'codex', available: false, cli_skill_ready: false },
          ],
        });
      })
    );
  });

  const wrongMarketplaceRunner = makeRunner(parts => {
    if (parts.join(' ') === 'claude --version') return { stdout: '2.1.0' };
    if (parts.join(' ') === 'codex --version') return { exitCode: 127 };
    if (parts.join(' ') === 'claude plugin marketplace list --json') {
      return {
        stdout: JSON.stringify([
          {
            name: 'composio',
            source: { source: 'github', repo: 'someone-else/not-composio' },
          },
        ]),
      };
    }
    if (parts.join(' ') === 'claude plugin list --json') return { stdout: '[]' };
    return {};
  });
  layer(TestLive({ commandRunner: wrongMarketplaceRunner }))('exact marketplace status', it => {
    it.scoped('does not accept a same-named marketplace from the wrong repository', () =>
      Effect.gen(function* () {
        yield* cli(['setup', 'status', '--json']);
        const [line] = yield* MockConsole.getLines();
        const status = JSON.parse(line ?? '{}') as {
          targets?: Array<Record<string, unknown>>;
        };
        expect(status.targets?.find(item => item.target === 'claude')).toMatchObject({
          marketplace_configured: false,
        });
      })
    );
  });

  const failingInstallRunner = makeRunner(parts => {
    if (parts.join(' ') === 'claude --version') return { stdout: '2.1.0' };
    if (parts.join(' ') === 'claude plugin marketplace list --json') return { stdout: '[]' };
    if (parts.join(' ') === 'claude plugin list --json') return { stdout: '[]' };
    if (parts.includes('install')) return { exitCode: 2, stderr: 'install failed' };
    return {};
  });
  layer(TestLive({ fixture: 'user-config-example', commandRunner: failingInstallRunner }))(
    'partial failure',
    it => {
      it.scoped('fails the command when a native plugin install fails', () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(cli(['setup', '--target', 'claude', '--yes']));
          expect(Exit.isFailure(exit)).toBe(true);
        })
      );
    }
  );

  const failingSkillInstaller = new SetupSkillInstaller({
    isClaudeSkillInstalled: Effect.succeed(false),
    ensureClaudeSkill: Effect.fail(new Error('skill download failed')),
  });
  layer(
    TestLive({
      fixture: 'user-config-example',
      commandRunner: humanRunner,
      setupSkillInstaller: failingSkillInstaller,
    })
  )('skill failure', it => {
    it.scoped('fails rather than reporting readiness when the required Claude skill fails', () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(cli(['setup', '--target', 'claude', '--yes']));
        expect(Exit.isFailure(exit)).toBe(true);
      })
    );
  });
});
