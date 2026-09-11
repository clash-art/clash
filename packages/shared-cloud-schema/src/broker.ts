import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Capability-broker audit log. Never stores credential values or payload bodies. */
export const pluginBrokerAudit = sqliteTable(
  "plugin_broker_audit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    capabilityId: text("capability_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    projectId: text("project_id").notNull(),
    invocationId: text("invocation_id").notNull(),
    requestId: text("request_id").notNull(),
    operation: text("operation").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => ({
    pluginBrokerAuditPluginIdx: index("plugin_broker_audit_plugin_idx").on(
      table.pluginId,
      table.occurredAt,
    ),
    pluginBrokerAuditInvocationIdx: index(
      "plugin_broker_audit_invocation_idx",
    ).on(table.invocationId, table.occurredAt),
  }),
);
