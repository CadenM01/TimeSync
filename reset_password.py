"""One-off password reset utility.

Usage:
    python3 reset_password.py <username> <new_password>

Connects to the MongoDB instance configured in .env and overwrites the
password hash for the given user. Use this only for admin/dev recovery.
"""
import os
import sys
from pymongo import MongoClient
from werkzeug.security import generate_password_hash


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 reset_password.py <username> <new_password>")
        sys.exit(1)

    username = sys.argv[1].strip().lower()
    new_password = sys.argv[2]

    load_env()
    uri = os.environ.get("MONGODB_URI")
    db_name = os.environ.get("MONGODB_DB", "timesync")
    if not uri:
        print("MONGODB_URI not set in .env")
        sys.exit(1)

    client = MongoClient(uri)
    users = client[db_name]["users"]

    user = users.find_one({"username": username})
    if not user:
        # Try by email too, in case migration has happened
        user = users.find_one({"email": username})
        if not user:
            print(f"No user found with username/email '{username}'")
            sys.exit(1)

    result = users.update_one(
        {"_id": user["_id"]},
        {"$set": {"passwordHash": generate_password_hash(new_password, method="pbkdf2:sha256")}},
    )
    if result.modified_count == 1:
        print(f"Password for '{username}' reset successfully.")
    else:
        print("No changes were made.")


if __name__ == "__main__":
    main()
