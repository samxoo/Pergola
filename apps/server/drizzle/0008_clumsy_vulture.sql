ALTER TABLE "board" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
/*
 * Boards that predate the column: credit the first person who joined, which on
 * every board made by this app is whoever created it — creation is what puts
 * the first member row there.
 */
UPDATE "board" b
SET "created_by" = (
  SELECT m."user_id" FROM "board_member" m
  WHERE m."board_id" = b."id"
  ORDER BY m."created_at" ASC
  LIMIT 1
)
WHERE b."created_by" IS NULL;
