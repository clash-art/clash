import * as m from "../agents/project-room";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
