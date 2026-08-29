CREATE TABLE "custom_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_value" (
	"card_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "custom_field_value_card_id_field_id_pk" PRIMARY KEY("card_id","field_id")
);
--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_field_id_custom_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_board_idx" ON "custom_field" USING btree ("board_id","position");