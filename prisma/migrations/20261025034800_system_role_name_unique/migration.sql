-- System roles (ownerId IS NULL) need unique names, but Postgres treats
-- NULLs as distinct in the @@unique([ownerId, name]) index, so two
-- admins could create the same system role. This partial unique index
-- is the backstop; createRole maps its P2002 to a clean 409.
-- NOTE: this migration FAILS if duplicate system role names already
-- exist — dedupe them before applying.
CREATE UNIQUE INDEX "Role_system_name_key" ON "Role"("name") WHERE "ownerId" IS NULL;
