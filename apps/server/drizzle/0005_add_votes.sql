CREATE TABLE "card_vote" (
	"card_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_vote_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "card_vote" ADD CONSTRAINT "card_vote_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_vote" ADD CONSTRAINT "card_vote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;