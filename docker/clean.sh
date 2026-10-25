#!/bin/bash
# Wipes the Neo4j database volume and logs. Stop the stack first (docker compose down).

docker volume rm painter-database
sudo rm -rf db/logs/*
