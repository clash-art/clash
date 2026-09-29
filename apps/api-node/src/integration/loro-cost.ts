import { LoroDoc } from "loro-crdt";
import { randomBytes } from "node:crypto";
for (const freshPeer of [true, false]) {
  const doc = new LoroDoc();
  const writer = new LoroDoc();
  for (let n = 1; n <= 4000; n++) {
    const source = freshPeer ? new LoroDoc() : writer;
    const from = source.version();
    source
      .getMap("entries")
      .set(String(n), randomBytes(768).toString("base64"));
    source.commit();
    const update = source.export({ mode: "update", from });
    from.free();
    doc.import(update);
    if (freshPeer) source.free();
    if ([100, 1000, 2000, 4000].includes(n)) {
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        const copy = doc.fork();
        copy.free();
      }
      console.log(
        JSON.stringify({
          freshPeer,
          events: n,
          forkMs: (performance.now() - start) / 10,
        }),
      );
    }
  }
  doc.free();
  writer.free();
}
