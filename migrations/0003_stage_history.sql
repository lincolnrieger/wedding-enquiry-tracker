-- Every stage an enquiry has ever been in (JSON array of stage ids), so the summary can show
-- how far enquiries got before being lost (e.g. lost after touring vs. lost after booking).
-- Runs automatically once; existing enquiries start with just their current stage.
ALTER TABLE enquiries ADD COLUMN stage_history TEXT NOT NULL DEFAULT '[]';
UPDATE enquiries SET stage_history = json_array(stage_id) WHERE stage_id IS NOT NULL;
