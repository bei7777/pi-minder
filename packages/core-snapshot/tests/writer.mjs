import { once } from "node:events";
import { openSnapshot } from "../lib/index.js";

const manager = await openSnapshot(JSON.parse(process.argv[2]));
const tx = await manager.begin("crash recovery");
for (let i = 0; i < 100; i++) {
  await tx.write("item-" + String(i).padStart(3,"0"),"real staged bytes");
}
const publish = once(process,"message");
process.send(tx.id);
await publish;
await tx.commit();
if (process.argv[3] === "undo") {
  const undo = once(process,"message");
  process.send("committed");
  await undo;
  await manager.undo(tx.id);
}
manager.close();
