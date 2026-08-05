#!/bin/sh
# Runs once, only against a freshly-initialized erria-pgdata volume — Postgres only executes
# scripts under /docker-entrypoint-initdb.d on first boot of an empty data directory, per the
# postgres image's own entrypoint contract. Not a migration; there is nothing to re-run.
#
# Creates a second database on this same Postgres server for Keycloak (issue #57: "a separate
# database on the same server, not a separate server"), with its own role rather than reusing
# POSTGRES_USER, so Keycloak's access is scoped to its own data.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE USER keycloak WITH PASSWORD '$KEYCLOAK_DB_PASSWORD';
	CREATE DATABASE keycloak OWNER keycloak;
EOSQL
