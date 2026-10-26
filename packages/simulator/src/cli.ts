import { DEFAULT_PORT, startSimulator } from './server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

const sim = await startSimulator({
  port: num(arg('port') ?? process.env.PORT) ?? DEFAULT_PORT,
  host: arg('host') ?? process.env.HOST ?? '0.0.0.0',
  model: arg('model'),
  outputPorts: num(arg('output-ports')),
  receivingCards: num(arg('receiving-cards')),
});
console.log(
  `RockzaLCT simulator: ${sim.state.model}, ${sim.state.outputPorts} ports, ` +
    `${sim.state.receivingCards.length} receiving cards, listening on ${sim.host}:${sim.port}`,
);

const stop = () => {
  void sim.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
