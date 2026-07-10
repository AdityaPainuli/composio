import { Command as PlatformCommand } from '@effect/platform';
import { Command, Options } from '@effect/cli';
import { Effect, Option } from 'effect';
import {
  ensureAgentSignupAllowed,
  getCurrentLoggedInAgent,
  getOrSignupReadyAgent,
  loginWithAgentIdentity,
} from 'src/services/agents';
import { CommandRunner } from 'src/services/command-runner';
import {
  inspectSetupTargets,
  installSetupTargets,
  resolveSetupTargets,
  SETUP_TARGETS,
  type SetupTarget,
} from 'src/services/setup';
import { TerminalUI } from 'src/services/terminal-ui';
import { ComposioUserContext } from 'src/services/user-context';

const agent = Options.boolean('agent').pipe(
  Options.withDefault(false),
  Options.withDescription(
    'Restore or create a browserless Composio agent identity instead of using human login'
  )
);

const target = Options.choice('target', SETUP_TARGETS).pipe(
  Options.withDefault('auto' as SetupTarget),
  Options.withDescription('Agent host to configure: auto, claude, codex, or all')
);

const yes = Options.boolean('yes').pipe(
  Options.withAlias('y'),
  Options.withDefault(false),
  Options.withDescription('Accept setup changes without prompting')
);

const json = Options.boolean('json').pipe(
  Options.withDefault(false),
  Options.withDescription('Print machine-readable JSON')
);

const ensureHumanIdentity = (yes: boolean) =>
  Effect.gen(function* () {
    const ctx = yield* ComposioUserContext;
    if (ctx.isLoggedIn()) return 'existing' as const;

    const runner = yield* CommandRunner;
    const args = ['login', '--no-skill-install', ...(yes ? ['--yes'] : [])];
    const loginCommand = PlatformCommand.make('composio', ...args).pipe(
      PlatformCommand.stdin('inherit'),
      PlatformCommand.stdout('inherit'),
      PlatformCommand.stderr('inherit')
    );
    const exitCode = yield* runner.run(loginCommand);
    if (Number(exitCode) !== 0) {
      return yield* Effect.fail(new Error(`Composio login failed (exit ${Number(exitCode)})`));
    }
    return 'created' as const;
  });

const ensureAgentIdentity = Effect.gen(function* () {
  yield* ensureAgentSignupAllowed;
  const current = yield* getCurrentLoggedInAgent;
  if (Option.isSome(current)) return 'existing' as const;

  const identity = yield* getOrSignupReadyAgent();
  yield* loginWithAgentIdentity(identity);
  return 'created' as const;
});

const setupStatusCmd = Command.make('status', { json }).pipe(
  Command.withDescription('Inspect Composio identity and agent plugin installation status.'),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const ui = yield* TerminalUI;
      const ctx = yield* ComposioUserContext;
      const currentAgent = yield* getCurrentLoggedInAgent;
      const targets = yield* inspectSetupTargets;
      const result = {
        authenticated: ctx.isLoggedIn(),
        identity: Option.isSome(currentAgent) ? 'agent' : ctx.isLoggedIn() ? 'human' : null,
        targets,
      };

      if (!json) {
        yield* ui.note(
          [
            `Identity: ${result.identity ?? 'not authenticated'}`,
            ...targets.map(item => {
              const state = !item.available
                ? 'not detected'
                : !item.plugin_installed
                  ? 'not installed'
                  : item.plugin_enabled
                    ? 'installed and enabled'
                    : 'installed but disabled';
              return `${item.target}: ${state}`;
            }),
            ...targets
              .filter(item => item.available)
              .map(
                item => `${item.target} CLI skill: ${item.cli_skill_ready ? 'ready' : 'not ready'}`
              ),
          ].join('\n'),
          'Composio setup status'
        );
      }
      yield* ui.output(JSON.stringify(result), { force: json });
    })
  )
);

const setupBaseCmd = Command.make('setup', { agent, target, yes }, ({ agent, target, yes }) =>
  Effect.gen(function* () {
    const ui = yield* TerminalUI;
    yield* ui.intro('composio setup');

    const targets = yield* resolveSetupTargets(target);
    if (!yes) {
      const confirmed = yield* ui.confirm(`Set up Composio for ${targets.join(' and ')}?`, {
        defaultValue: true,
      });
      if (!confirmed) {
        yield* ui.outro('Setup cancelled.');
        return;
      }
    }

    const identity = yield* agent ? ensureAgentIdentity : ensureHumanIdentity(yes);
    yield* ui.log.success(
      identity === 'existing'
        ? `Using the existing Composio ${agent ? 'agent ' : ''}identity.`
        : `Composio ${agent ? 'agent ' : ''}identity is ready.`
    );

    const results = yield* installSetupTargets(targets);
    for (const result of results) {
      yield* ui.log.success(
        result.plugin_changed
          ? `Configured and enabled the Composio plugin for ${result.target}.`
          : `The Composio plugin for ${result.target} is already installed and enabled.`
      );
      if (result.target === 'claude') {
        yield* ui.log.success(
          result.skill_changed
            ? 'Installed the composio-cli skill for Claude Code.'
            : 'The composio-cli skill for Claude Code is already installed.'
        );
      } else {
        yield* ui.log.success('The Codex plugin includes the composio-cli skill.');
      }
    }

    yield* ui.output(
      JSON.stringify({
        success: true,
        identity: agent ? 'agent' : 'human',
        identity_changed: identity === 'created',
        targets: results,
      })
    );
    yield* ui.outro('Composio setup complete.');
  })
);

export const setupCmd = setupBaseCmd.pipe(
  Command.withDescription('Authenticate Composio and install plugins for supported agent hosts.'),
  Command.withSubcommands([setupStatusCmd])
);
