#!/bin/bash
# Stop the stack first (docker compose down); the volume is in use otherwise.

docker volume rm painter-database
sudo rm -rf db/logs/*
