import * as m from "../app-routes";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
