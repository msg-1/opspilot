-- Runs once, when the Postgres volume is first created.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE opspilot_test OWNER opspilot;
\connect opspilot_test
CREATE EXTENSION IF NOT EXISTS vector;
