import io
import os
import random
import re
import string
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# Auto-load .env file if present (for local development)
_env_path = Path(__file__).resolve().parent / ".env"
if _env_path.is_file():
    with open(_env_path) as _ef:
        for _line in _ef:
            _line = _line.strip()
            if not _line or _line.startswith("#"):
                continue
            if "=" in _line:
                _key, _, _val = _line.partition("=")
                _key = _key.strip()
                _val = _val.strip().strip("'\"")
                if _key and _key not in os.environ:
                    os.environ[_key] = _val

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, url_for
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
except ImportError:
    LoginManager = None

try:
    import certifi
except ImportError:
    certifi = None

try:
    from pymongo import MongoClient
    from pymongo.errors import PyMongoError
except ImportError:
    MongoClient = None
    PyMongoError = Exception

try:
    from PIL import Image
    import pytesseract
except ImportError:
    Image = None
    pytesseract = None

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")

MONGODB_URI = os.environ.get("MONGODB_URI", "").strip()
MONGODB_DB = os.environ.get("MONGODB_DB", "timesync").strip() or "timesync"
MONGODB_TLS_INSECURE = os.environ.get("MONGODB_TLS_INSECURE", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

mongo_init_error = None
mongo_client = None
if MONGODB_URI and MongoClient:
    try:
        mongo_options = {
            "serverSelectionTimeoutMS": 30000,
            "connectTimeoutMS": 20000,
            "socketTimeoutMS": 20000,
        }
        if certifi is not None:
            mongo_options["tlsCAFile"] = certifi.where()
        if MONGODB_TLS_INSECURE:
            # Debug-only escape hatch for strict/intercepted networks.
            mongo_options["tlsAllowInvalidCertificates"] = True
        mongo_client = MongoClient(MONGODB_URI, **mongo_options)
    except Exception as err:
        mongo_init_error = str(err)

_indexes_initialized = False


def schedules_collection():
    if not mongo_client:
        return None
    return mongo_client[MONGODB_DB]["schedules"]


def users_collection():
    if not mongo_client:
        return None
    return mongo_client[MONGODB_DB]["users"]


def ensure_indexes():
    global _indexes_initialized
    if _indexes_initialized:
        return
    col = schedules_collection()
    if col is not None:
        col.create_index("userKey", unique=True)
    ucol = users_collection()
    if ucol is not None:
        ucol.create_index("username", unique=True)
        ucol.create_index("friendCode", unique=True)
    _indexes_initialized = True


# ---------- Auth helpers ----------

FRIEND_CODE_CHARS = "".join(
    c for c in string.ascii_uppercase + string.digits if c not in "0OI1L"
)


def generate_friend_code(length: int = 6) -> str:
    col = users_collection()
    for _ in range(20):
        code = "".join(random.choices(FRIEND_CODE_CHARS, k=length))
        if col is None or not col.find_one({"friendCode": code}):
            return code
    return "".join(random.choices(FRIEND_CODE_CHARS, k=length))


if LoginManager is not None:
    class User(UserMixin):
        def __init__(self, doc):
            self.id = doc["username"]
            self.username = doc["username"]
            self.display_name = doc.get("displayName", doc["username"])
            self.friend_code = doc.get("friendCode", "")

    login_manager = LoginManager()
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(username):
        col = users_collection()
        if col is None:
            return None
        doc = col.find_one({"username": username})
        return User(doc) if doc else None

    @login_manager.unauthorized_handler
    def unauthorized():
        if request.accept_mimetypes.accept_json and not request.accept_mimetypes.accept_html:
            return jsonify({"ok": False, "error": "Authentication required."}), 401
        return redirect("/login")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_user_key(value: str) -> str:
    return (value or "").strip().lower()


def to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def to_hhmm(minutes: int) -> str:
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"


def merge_intervals(intervals):
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda x: x[0])
    merged = [list(intervals[0])]
    for s, e in intervals[1:]:
        last = merged[-1]
        if s <= last[1]:
            last[1] = max(last[1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def invert_to_free(merged_busy, day_start, day_end):
    free = []
    cur = day_start
    for s, e in merged_busy:
        if e <= day_start or s >= day_end:
            continue
        s = max(s, day_start)
        e = min(e, day_end)
        if cur < s:
            free.append((cur, s))
        cur = max(cur, e)
    if cur < day_end:
        free.append((cur, day_end))
    return free


def intersect_intervals(a, b):
    i = j = 0
    out = []
    while i < len(a) and j < len(b):
        s1, e1 = a[i]
        s2, e2 = b[j]
        s = max(s1, s2)
        e = min(e1, e2)
        if s < e:
            out.append((s, e))
        if e1 < e2:
            i += 1
        else:
            j += 1
    return out


def normalize_busy(busy_list):
    out = {d: [] for d in DAYS}
    for b in busy_list:
        day = b.get("day")
        start = b.get("start")
        end = b.get("end")
        if day not in out or not start or not end:
            continue
        if start >= end:
            continue
        out[day].append((to_minutes(start), to_minutes(end)))
    return out


def validated_busy_list(busy_list):
    normalized = []
    if not isinstance(busy_list, list):
        return normalized

    for b in busy_list:
        day = b.get("day")
        start = b.get("start")
        end = b.get("end")
        if day not in DAYS or not isinstance(start, str) or not isinstance(end, str):
            continue
        if len(start) != 5 or len(end) != 5:
            continue
        if start >= end:
            continue
        normalized.append({"day": day, "start": start, "end": end})
    return normalized


def busy_signature(busy_list):
    return sorted((b.get("day"), b.get("start"), b.get("end")) for b in (busy_list or []))


def busy_lists_equal(a, b):
    return busy_signature(a) == busy_signature(b)


def default_profile(user_key: str):
    return {
        "userKey": user_key,
        "mySchedule": {"name": "My Schedule", "busy": []},
        "comparisonSchedules": [],
        "selectedComparisonId": None,
        "updatedAt": None,
    }


def sanitize_comparison_schedule(item: dict, idx: int):
    schedule_id = str(item.get("id") or f"cmp-{uuid4().hex[:8]}")
    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        name = f"Comparison {idx + 1}"

    source_user_key = item.get("sourceUserKey")
    if isinstance(source_user_key, str):
        source_user_key = normalize_user_key(source_user_key) or None
    else:
        source_user_key = None

    updated_at = item.get("updatedAt")
    if not isinstance(updated_at, str) or not updated_at:
        updated_at = now_iso()

    return {
        "id": schedule_id,
        "name": name.strip(),
        "busy": validated_busy_list(item.get("busy", [])),
        "sourceUserKey": source_user_key,
        "updatedAt": updated_at,
    }


def normalize_profile_doc(doc, user_key: str):
    profile = default_profile(user_key)
    if not doc:
        return profile

    profile["updatedAt"] = doc.get("updatedAt")

    # New schema
    if "mySchedule" in doc or "comparisonSchedules" in doc:
        my_schedule = doc.get("mySchedule", {})
        if not isinstance(my_schedule, dict):
            my_schedule = {}

        my_name = my_schedule.get("name")
        if not isinstance(my_name, str) or not my_name.strip():
            my_name = "My Schedule"

        profile["mySchedule"] = {
            "name": my_name.strip(),
            "busy": validated_busy_list(my_schedule.get("busy", [])),
        }

        raw_comparisons = doc.get("comparisonSchedules", [])
        comparisons = []
        if isinstance(raw_comparisons, list):
            for idx, item in enumerate(raw_comparisons):
                if isinstance(item, dict):
                    comparisons.append(sanitize_comparison_schedule(item, idx))

        # Ignore accidentally self-imported comparison schedules.
        comparisons = [c for c in comparisons if c.get("sourceUserKey") != user_key]
        profile["comparisonSchedules"] = comparisons

        selected = doc.get("selectedComparisonId")
        valid_ids = {c["id"] for c in comparisons}
        if isinstance(selected, str) and selected in valid_ids:
            profile["selectedComparisonId"] = selected
        else:
            profile["selectedComparisonId"] = None

        return profile

    # Legacy schema fallback (personA / personB)
    person_a = doc.get("personA", {})
    person_b = doc.get("personB", {})

    if not isinstance(person_a, dict):
        person_a = {}
    if not isinstance(person_b, dict):
        person_b = {}

    my_name = person_a.get("name")
    if not isinstance(my_name, str) or not my_name.strip():
        my_name = "My Schedule"

    profile["mySchedule"] = {
        "name": my_name.strip(),
        "busy": validated_busy_list(person_a.get("busy", [])),
    }

    legacy_busy = validated_busy_list(person_b.get("busy", []))
    if legacy_busy and not busy_lists_equal(legacy_busy, profile["mySchedule"]["busy"]):
        legacy_item = sanitize_comparison_schedule(
            {
                "id": f"legacy-{uuid4().hex[:8]}",
                "name": person_b.get("name") or "Comparison 1",
                "busy": legacy_busy,
                "updatedAt": doc.get("updatedAt") or now_iso(),
            },
            0,
        )
        profile["comparisonSchedules"] = [legacy_item]
        profile["selectedComparisonId"] = legacy_item["id"]

    return profile


def profile_doc_from_payload(user_key: str, payload: dict, existing_doc=None):
    base_profile = normalize_profile_doc(existing_doc, user_key)
    data = payload if isinstance(payload, dict) else {}

    my_input = data.get("mySchedule", {})
    if not isinstance(my_input, dict):
        my_input = {}

    my_name = my_input.get("name")
    if not isinstance(my_name, str) or not my_name.strip():
        my_name = base_profile["mySchedule"].get("name") or "My Schedule"

    profile = {
        "userKey": user_key,
        "mySchedule": {
            "name": my_name.strip(),
            "busy": validated_busy_list(my_input.get("busy", [])),
        },
        "comparisonSchedules": [],
        "selectedComparisonId": None,
        "updatedAt": now_iso(),
    }

    raw_comparisons = data.get("comparisonSchedules", [])
    if isinstance(raw_comparisons, list):
        for idx, item in enumerate(raw_comparisons):
            if isinstance(item, dict):
                profile["comparisonSchedules"].append(sanitize_comparison_schedule(item, idx))

    selected = data.get("selectedComparisonId")
    valid_ids = {c["id"] for c in profile["comparisonSchedules"]}
    if isinstance(selected, str) and selected in valid_ids:
        profile["selectedComparisonId"] = selected
    else:
        profile["selectedComparisonId"] = None

    return profile


def selected_comparison_schedule(profile: dict):
    selected_id = profile.get("selectedComparisonId")
    comparisons = profile.get("comparisonSchedules", [])

    if selected_id:
        for item in comparisons:
            if item.get("id") == selected_id:
                return item

    if comparisons:
        return comparisons[0]

    return {"id": None, "name": "Comparison Schedule", "busy": []}


def db_unavailable_response():
    if MongoClient is None:
        return jsonify({"ok": False, "error": "Missing dependency: install pymongo."}), 500
    if mongo_init_error:
        return jsonify({"ok": False, "error": f"MongoDB URI invalid: {mongo_init_error}"}), 500
    col = schedules_collection()
    if col is None:
        return jsonify(
            {
                "ok": False,
                "error": "Database not configured. Set MONGODB_URI and MONGODB_DB.",
            }
        ), 500
    return None


@app.get("/login")
def login_page():
    if LoginManager is not None and current_user.is_authenticated:
        return redirect("/")
    return render_template("login.html")


@app.get("/")
def index():
    if LoginManager is not None and not current_user.is_authenticated:
        return redirect("/login")
    return render_template("index.html")


@app.get("/prototypes/<path:filename>")
def serve_prototype(filename):
    return send_from_directory("prototypes", filename)


# ---------- Auth routes ----------

@app.get("/api/auth/me")
def auth_me():
    if LoginManager is None:
        return jsonify({"ok": False, "error": "flask-login not installed."}), 500
    if current_user.is_authenticated:
        return jsonify({
            "ok": True,
            "username": current_user.username,
            "displayName": current_user.display_name,
            "friendCode": current_user.friend_code,
        })
    return jsonify({"ok": False, "error": "Not authenticated."}), 401


@app.post("/api/auth/signup")
def auth_signup():
    if LoginManager is None:
        return jsonify({"ok": False, "error": "flask-login not installed."}), 500

    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    data = request.get_json(force=True) or {}
    username = normalize_user_key(data.get("username", ""))
    password = (data.get("password") or "").strip()
    display_name = (data.get("displayName") or "").strip()

    if not USERNAME_PATTERN.match(username):
        return jsonify({"ok": False, "error": "Username must be 3-32 chars: lowercase letters, numbers, '-' or '_'."}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "error": "Password must be at least 6 characters."}), 400

    col = users_collection()
    try:
        ensure_indexes()
        if col.find_one({"username": username}):
            return jsonify({"ok": False, "error": "Username already taken."}), 409

        friend_code = generate_friend_code()
        user_doc = {
            "username": username,
            "passwordHash": generate_password_hash(password),
            "displayName": display_name or username,
            "friendCode": friend_code,
            "createdAt": now_iso(),
        }
        col.insert_one(user_doc)

        user = User(user_doc)
        login_user(user, remember=True)

        return jsonify({
            "ok": True,
            "username": username,
            "displayName": user.display_name,
            "friendCode": friend_code,
        })
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500


@app.post("/api/auth/login")
def auth_login():
    if LoginManager is None:
        return jsonify({"ok": False, "error": "flask-login not installed."}), 500

    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    data = request.get_json(force=True) or {}
    username = normalize_user_key(data.get("username", ""))
    password = (data.get("password") or "").strip()

    if not username or not password:
        return jsonify({"ok": False, "error": "Username and password are required."}), 400

    col = users_collection()
    try:
        ensure_indexes()
        user_doc = col.find_one({"username": username})
        if not user_doc or not check_password_hash(user_doc["passwordHash"], password):
            return jsonify({"ok": False, "error": "Invalid username or password."}), 401

        user = User(user_doc)
        login_user(user, remember=True)

        return jsonify({
            "ok": True,
            "username": username,
            "displayName": user.display_name,
            "friendCode": user.friend_code,
        })
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500


@app.post("/api/auth/logout")
def auth_logout():
    if LoginManager is None:
        return jsonify({"ok": False, "error": "flask-login not installed."}), 500
    logout_user()
    return jsonify({"ok": True})


@app.post("/compare")
def compare():
    data = request.get_json(force=True)
    personA = data.get("personA", {})
    personB = data.get("personB", {})

    a_busy = normalize_busy(personA.get("busy", []))
    b_busy = normalize_busy(personB.get("busy", []))

    day_start = to_minutes("07:00")
    day_end = to_minutes("22:00")

    overlap_free = {}

    for day in DAYS:
        a_merged = merge_intervals(a_busy[day])
        b_merged = merge_intervals(b_busy[day])

        a_free = invert_to_free(a_merged, day_start, day_end)
        b_free = invert_to_free(b_merged, day_start, day_end)

        common = intersect_intervals(a_free, b_free)

        overlap_free[day] = [{"start": to_hhmm(s), "end": to_hhmm(e)} for s, e in common]

    return jsonify({"ok": True, "overlapFree": overlap_free})


@app.get("/api/health/db")
def db_health():
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    try:
        ensure_indexes()
        mongo_client.admin.command("ping")
        return jsonify({"ok": True, "database": MONGODB_DB})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500


def _require_auth():
    """Check if user is authenticated. Returns None if ok, or a JSON error response."""
    if LoginManager is None:
        return None  # Auth not available, allow through
    if not current_user.is_authenticated:
        return jsonify({"ok": False, "error": "Authentication required."}), 401
    return None


@app.get("/api/profiles/<user_key>")
def get_profile(user_key):
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    # Users can only access their own profile
    if LoginManager and current_user.is_authenticated and key != current_user.username:
        return jsonify({"ok": False, "error": "Access denied."}), 403

    col = schedules_collection()
    try:
        ensure_indexes()
        doc = col.find_one({"userKey": key}, {"_id": 0})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    profile = normalize_profile_doc(doc, key)
    return jsonify({"ok": True, **profile})


@app.post("/api/profiles/<user_key>")
def save_profile(user_key):
    auth_err = _require_auth()
    if auth_err:
        return auth_err

    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    if LoginManager and current_user.is_authenticated and key != current_user.username:
        return jsonify({"ok": False, "error": "Access denied."}), 403

    data = request.get_json(force=True) or {}
    col = schedules_collection()

    try:
        ensure_indexes()
        existing_doc = col.find_one({"userKey": key}, {"_id": 0})
        profile_doc = profile_doc_from_payload(key, data, existing_doc)
        col.update_one({"userKey": key}, {"$set": profile_doc}, upsert=True)
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    return jsonify({"ok": True, **profile_doc})


@app.get("/api/public-schedules/<user_key>")
def get_public_schedule(user_key):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    col = schedules_collection()
    try:
        ensure_indexes()
        doc = col.find_one({"userKey": key}, {"_id": 0})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    if not doc:
        return jsonify({"ok": False, "error": "Friend user ID not found."}), 404

    profile = normalize_profile_doc(doc, key)
    return jsonify(
        {
            "ok": True,
            "userKey": key,
            "mySchedule": profile["mySchedule"],
            "updatedAt": profile.get("updatedAt"),
        }
    )


@app.get("/api/public-schedules/by-code/<friend_code>")
def get_public_schedule_by_code(friend_code):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    code = (friend_code or "").strip().upper()
    if not code or len(code) < 4:
        return jsonify({"ok": False, "error": "Invalid friend code."}), 400

    ucol = users_collection()
    if ucol is None:
        return jsonify({"ok": False, "error": "Database not configured."}), 500

    try:
        ensure_indexes()
        user_doc = ucol.find_one({"friendCode": code})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    if not user_doc:
        return jsonify({"ok": False, "error": "Friend code not found."}), 404

    username = user_doc["username"]
    col = schedules_collection()
    try:
        doc = col.find_one({"userKey": username}, {"_id": 0})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    if not doc:
        return jsonify({"ok": False, "error": "Friend has no schedule yet."}), 404

    profile = normalize_profile_doc(doc, username)
    return jsonify({
        "ok": True,
        "userKey": username,
        "displayName": user_doc.get("displayName", username),
        "mySchedule": profile["mySchedule"],
        "updatedAt": profile.get("updatedAt"),
    })


@app.post("/api/profiles/<user_key>/comparison-schedules/import")
def import_friend_schedule(user_key):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    payload = request.get_json(force=True) or {}
    friend_key = normalize_user_key(payload.get("friendUserKey", ""))
    if not friend_key:
        return jsonify({"ok": False, "error": "friendUserKey is required"}), 400
    if friend_key == key:
        return jsonify({"ok": False, "error": "Use a different user ID. You cannot import your own schedule."}), 400

    col = schedules_collection()

    try:
        ensure_indexes()
        friend_doc = col.find_one({"userKey": friend_key}, {"_id": 0})
        if not friend_doc:
            return jsonify({"ok": False, "error": "Friend user ID not found."}), 404

        friend_profile = normalize_profile_doc(friend_doc, friend_key)
        target_doc = col.find_one({"userKey": key}, {"_id": 0})
        target_profile = normalize_profile_doc(target_doc, key)

        import_name = payload.get("name")
        if not isinstance(import_name, str) or not import_name.strip():
            import_name = f"{friend_profile['mySchedule']['name']} ({friend_key})"

        imported = sanitize_comparison_schedule(
            {
                "id": f"cmp-{uuid4().hex[:8]}",
                "name": import_name,
                "busy": friend_profile["mySchedule"]["busy"],
                "sourceUserKey": friend_key,
                "updatedAt": now_iso(),
            },
            len(target_profile["comparisonSchedules"]),
        )

        target_profile["comparisonSchedules"].append(imported)
        target_profile["selectedComparisonId"] = imported["id"]
        target_profile["updatedAt"] = now_iso()

        col.update_one({"userKey": key}, {"$set": target_profile}, upsert=True)
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    return jsonify(
        {
            "ok": True,
            "comparisonSchedule": imported,
            "selectedComparisonId": target_profile["selectedComparisonId"],
            "updatedAt": target_profile["updatedAt"],
        }
    )


# Backward-compatible endpoints for old frontend payloads.
@app.get("/api/schedules/<user_key>")
def get_schedule(user_key):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    col = schedules_collection()
    try:
        ensure_indexes()
        doc = col.find_one({"userKey": key}, {"_id": 0})
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    profile = normalize_profile_doc(doc, key)
    selected = selected_comparison_schedule(profile)

    return jsonify(
        {
            "ok": True,
            "userKey": key,
            "personA": profile["mySchedule"],
            "personB": {
                "name": selected.get("name") or "Comparison Schedule",
                "busy": selected.get("busy", []),
            },
            "updatedAt": profile.get("updatedAt"),
        }
    )


@app.post("/api/schedules/<user_key>")
def save_schedule(user_key):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

    data = request.get_json(force=True) or {}
    person_a = data.get("personA", {})
    person_b = data.get("personB", {})

    col = schedules_collection()

    try:
        ensure_indexes()
        existing_doc = col.find_one({"userKey": key}, {"_id": 0})
        profile = normalize_profile_doc(existing_doc, key)

        a_name = person_a.get("name") if isinstance(person_a, dict) else None
        if not isinstance(a_name, str) or not a_name.strip():
            a_name = "My Schedule"

        profile["mySchedule"] = {
            "name": a_name.strip(),
            "busy": validated_busy_list((person_a or {}).get("busy", [])),
        }

        b_name = (person_b or {}).get("name") if isinstance(person_b, dict) else None
        if not isinstance(b_name, str) or not b_name.strip():
            b_name = "Comparison Schedule"

        b_busy = validated_busy_list((person_b or {}).get("busy", []))

        selected_id = profile.get("selectedComparisonId")
        selected_index = None
        for i, item in enumerate(profile["comparisonSchedules"]):
            if item.get("id") == selected_id:
                selected_index = i
                break

        if selected_index is None:
            item = sanitize_comparison_schedule(
                {
                    "id": f"cmp-{uuid4().hex[:8]}",
                    "name": b_name,
                    "busy": b_busy,
                    "updatedAt": now_iso(),
                },
                len(profile["comparisonSchedules"]),
            )
            profile["comparisonSchedules"].append(item)
            profile["selectedComparisonId"] = item["id"]
        else:
            profile["comparisonSchedules"][selected_index] = sanitize_comparison_schedule(
                {
                    **profile["comparisonSchedules"][selected_index],
                    "name": b_name,
                    "busy": b_busy,
                    "updatedAt": now_iso(),
                },
                selected_index,
            )

        profile["updatedAt"] = now_iso()
        col.update_one({"userKey": key}, {"$set": profile}, upsert=True)
    except PyMongoError as err:
        return jsonify({"ok": False, "error": str(err)}), 500

    return jsonify({"ok": True, "userKey": key, "updatedAt": profile["updatedAt"]})


# ---------- Schedule Import / Parsing ----------

# Day abbreviation mappings from various formats to our standard DAYS
DAY_MAP = {
    "mo": "Mon", "mon": "Mon", "monday": "Mon", "m": "Mon",
    "tu": "Tue", "tue": "Tue", "tuesday": "Tue", "t": "Tue",
    "we": "Wed", "wed": "Wed", "wednesday": "Wed", "w": "Wed",
    "th": "Thu", "thu": "Thu", "thursday": "Thu", "r": "Thu",
    "fr": "Fri", "fri": "Fri", "friday": "Fri", "f": "Fri",
    "sa": "Sat", "sat": "Sat", "saturday": "Sat",
    "su": "Sun", "sun": "Sun", "sunday": "Sun",
}

# PeopleSoft uses compact day codes like "MoWeFr" or "TuTh"
PEOPLESOFT_DAY_PATTERN = re.compile(r"(Mo|Tu|We|Th|Fr|Sa|Su)", re.IGNORECASE)


def parse_time_str(time_str: str):
    """Parse a time string like '9:00 AM', '09:00', '2:30pm', '14:30' into HH:MM 24-hour."""
    time_str = time_str.strip()

    # Try 12-hour format: 9:00 AM, 9:00AM, 2:30 pm
    m = re.match(r"(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)", time_str, re.IGNORECASE)
    if m:
        h = int(m.group(1))
        mi = int(m.group(2))
        ap = m.group(3).lower().replace(".", "")
        if ap == "pm" and h != 12:
            h += 12
        elif ap == "am" and h == 12:
            h = 0
        return f"{h:02d}:{mi:02d}"

    # Try 24-hour format: 09:00, 14:30
    m = re.match(r"(\d{1,2}):(\d{2})$", time_str)
    if m:
        h = int(m.group(1))
        mi = int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"

    return None


def parse_days_from_code(code: str):
    """Parse PeopleSoft day codes like 'MoWeFr' or 'TuTh' into list of standard day names."""
    matches = PEOPLESOFT_DAY_PATTERN.findall(code)
    if matches:
        return [DAY_MAP.get(m.lower(), None) for m in matches if m.lower() in DAY_MAP]
    return []


def parse_days_from_text(text: str):
    """Parse day names from text like 'Mon, Wed, Fri' or 'Monday Wednesday Friday'."""
    days = []
    # Try to match full/abbreviated day names
    tokens = re.split(r"[,\s/&]+", text.strip())
    for tok in tokens:
        tok_lower = tok.lower().rstrip(".")
        if tok_lower in DAY_MAP:
            days.append(DAY_MAP[tok_lower])
    return days


def parse_schedule_text(raw_text: str):
    """
    Parse schedule text in various formats and return busy blocks.

    Supports formats like:
    - "CS 4080-01: Concepts of Prgrming Languages | MoWeFr 09:00 AM - 09:50 AM | BLDG 8 345"
    - "Monday 09:00 AM 09:50 AM CS 4080"
    - Day sections like "__Monday__" followed by course/building lines and "09:00 am 09:50 am"
    - Tabular pasted text from CPP schedule pages
    - JSON array of {day, start, end} or {days, start, end, name}
    """
    raw_text = raw_text.strip()
    if not raw_text:
        return []

    # Try JSON first
    try:
        import json
        data = json.loads(raw_text)
        if isinstance(data, list):
            return _parse_json_schedule(data)
    except (json.JSONDecodeError, ValueError):
        pass

    busy_blocks = []

    # Strategy 1: Look for lines with time ranges and day codes
    # Pattern: days_code time_start - time_end  OR  time_start - time_end days_code
    time_range_pattern = re.compile(
        r"(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)\s*[-–—to]+\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)"
    )

    lines = raw_text.split("\n")
    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Find time ranges in this line
        time_matches = list(time_range_pattern.finditer(line))
        if not time_matches:
            continue

        # Find days in this line
        days = []

        # Try PeopleSoft compact codes first (MoWeFr, TuTh)
        ps_matches = list(PEOPLESOFT_DAY_PATTERN.finditer(line))
        if ps_matches:
            # Check if they form a contiguous block (PeopleSoft style)
            for ps_m in ps_matches:
                d = DAY_MAP.get(ps_m.group(1).lower())
                if d and d not in days:
                    days.append(d)

        # If no PeopleSoft codes, try standard day names
        if not days:
            days = parse_days_from_text(line)

        if not days:
            # Try to get days from context (look at nearby lines)
            # Check if this line might be under a day header
            for prev_line in reversed(lines[:lines.index(line) if line in lines else 0]):
                prev_line = prev_line.strip()
                ctx_days = parse_days_from_text(prev_line)
                if ctx_days:
                    days = ctx_days
                    break

        if not days:
            continue

        for tm in time_matches:
            start_str = tm.group(1)
            end_str = tm.group(2)

            start = parse_time_str(start_str)
            end = parse_time_str(end_str)

            if not start or not end:
                continue
            if start >= end:
                continue

            # Extract course name if present
            name = _extract_course_name(line)

            for day in days:
                busy_blocks.append({
                    "day": day,
                    "start": start,
                    "end": end,
                    "name": name or "Busy",
                })

    # Strategy 2: If no time ranges found, try block-by-block parsing
    # (for formats where each line is "Day StartTime EndTime CourseName")
    if not busy_blocks:
        busy_blocks = _parse_day_section_schedule(lines)

    if not busy_blocks:
        busy_blocks = _parse_line_by_line(lines)

    return busy_blocks


def _parse_json_schedule(data):
    """Parse a JSON array of schedule entries."""
    blocks = []
    for item in data:
        if not isinstance(item, dict):
            continue

        days = []
        if "day" in item:
            d = DAY_MAP.get(str(item["day"]).lower().strip(), None)
            if d:
                days = [d]
            elif str(item["day"]).strip() in DAYS:
                days = [str(item["day"]).strip()]
        if "days" in item:
            if isinstance(item["days"], list):
                for d in item["days"]:
                    mapped = DAY_MAP.get(str(d).lower().strip(), str(d).strip())
                    if mapped in DAYS:
                        days.append(mapped)
            elif isinstance(item["days"], str):
                days = parse_days_from_code(item["days"]) or parse_days_from_text(item["days"])

        start = parse_time_str(str(item.get("start", "")))
        end = parse_time_str(str(item.get("end", "")))
        name = item.get("name", item.get("course", item.get("title", "Busy")))

        if days and start and end and start < end:
            for day in days:
                blocks.append({"day": day, "start": start, "end": end, "name": name})

    return blocks


def _extract_course_name(line: str):
    """Try to extract a course name like 'CS 4080-01' from a line."""
    m = re.search(r"([A-Z]{2,5}\s*\d{3,5}(?:\s*-\s*\d{1,3})?)", line, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return None


def _parse_day_section_schedule(lines):
    """
    Parse day-by-day schedule text such as:

    __Monday__
    CS 4080-01: Concepts of Programming Languages
    Building: BLDG 8 345
    09:00 am 09:50 am
    """
    blocks = []
    current_day = None
    pending_name = None
    pending_start_time = None  # For when start/end times are on separate lines
    time_pattern = re.compile(r"(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)")
    day_header_pattern = re.compile(
        r"^[_*\s`>#-]*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[_*\s`>#-]*$",
        re.IGNORECASE,
    )

    ignored_prefixes = (
        "building:",
        "room:",
        "location:",
        "instructor:",
    )
    ignored_exact = {
        "hybrid synchronous",
        "hybrid asynchronous",
        "synchronous",
        "asynchronous",
        "online",
        "hybrid",
    }

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        day_match = day_header_pattern.match(line)
        if day_match:
            current_day = DAY_MAP.get(day_match.group(1).lower())
            pending_name = None
            pending_start_time = None
            continue

        if not current_day:
            continue

        normalized = line.lower().strip()
        if normalized.startswith(ignored_prefixes) or normalized in ignored_exact:
            continue

        times = time_pattern.findall(line)
        if len(times) >= 2:
            # Both times on the same line: "09:00 am 09:50 am"
            start = parse_time_str(times[0])
            end = parse_time_str(times[1])
            if start and end and start < end:
                blocks.append({
                    "day": current_day,
                    "start": start,
                    "end": end,
                    "name": pending_name or _extract_course_name(line) or "Class",
                })
            pending_name = None
            pending_start_time = None
            continue

        if len(times) == 1:
            # Single time on a line — could be start or end of a split pair
            parsed_time = parse_time_str(times[0])
            if parsed_time and pending_start_time:
                # This is the end time paired with the pending start
                if pending_start_time < parsed_time:
                    blocks.append({
                        "day": current_day,
                        "start": pending_start_time,
                        "end": parsed_time,
                        "name": pending_name or "Class",
                    })
                pending_name = None
                pending_start_time = None
            elif parsed_time:
                # This is the start time — wait for the next time line
                pending_start_time = parsed_time
            continue

        # Non-time, non-ignored line — check for course name
        pending_start_time = None  # Reset if a non-time line interrupts
        course_name = _extract_course_name(line)
        if course_name:
            pending_name = course_name

    return blocks


def _parse_line_by_line(lines):
    """Parse schedule where each line contains a day, start time, and end time."""
    blocks = []
    time_pattern = re.compile(r"(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)")

    for line in lines:
        line = line.strip()
        if not line:
            continue

        days = parse_days_from_text(line) or parse_days_from_code(line)
        if not days:
            continue

        times = time_pattern.findall(line)
        if len(times) >= 2:
            start = parse_time_str(times[0])
            end = parse_time_str(times[1])
            name = _extract_course_name(line)

            if start and end and start < end:
                for day in days:
                    blocks.append({"day": day, "start": start, "end": end, "name": name or "Busy"})

    return blocks


def parse_schedule_from_image(image_bytes: bytes):
    """
    Use OCR to extract text from a schedule image.
    Single pass with preprocessing — no multi-pass to avoid duplicates.
    Returns (text, error_string).
    """
    if Image is None or pytesseract is None:
        return None, "OCR dependencies (Pillow, pytesseract) are not installed."

    try:
        img = Image.open(io.BytesIO(image_bytes))

        # Convert to RGB if needed
        if img.mode != "RGB":
            img = img.convert("RGB")

        # Upscale small images
        w, h = img.size
        if w < 2000:
            scale = 2000 / w
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        # Convert to grayscale and enhance
        gray = img.convert("L")
        try:
            from PIL import ImageEnhance
            enhanced = gray.convert("RGB")
            enhanced = ImageEnhance.Contrast(enhanced).enhance(1.8)
            enhanced = ImageEnhance.Sharpness(enhanced).enhance(1.5)
            gray = enhanced.convert("L")
        except Exception:
            pass

        # Single OCR pass with auto page segmentation
        text = pytesseract.image_to_string(gray, config="--oem 3 --psm 3")

        # Also try structured extraction
        structured_lines = []
        try:
            tsv_data = pytesseract.image_to_data(
                gray, config="--oem 3 --psm 3",
                output_type=pytesseract.Output.DICT
            )
            lines_by_block = {}
            n = len(tsv_data.get("text", []))
            for i in range(n):
                t = str(tsv_data["text"][i]).strip()
                if not t:
                    continue
                key = (tsv_data["block_num"][i], tsv_data["par_num"][i], tsv_data["line_num"][i])
                if key not in lines_by_block:
                    lines_by_block[key] = []
                lines_by_block[key].append(t)

            for key in sorted(lines_by_block.keys()):
                structured_lines.append(" ".join(lines_by_block[key]))
        except Exception:
            pass

        # Combine: prefer structured if available, fall back to raw
        if structured_lines:
            combined = text + "\n" + "\n".join(structured_lines)
        else:
            combined = text or ""

        return combined, None

    except Exception as e:
        return None, f"OCR failed: {str(e)}"


def _parse_schedule_blocks_from_ocr(ocr_text: str):
    """
    Parse OCR output from schedule images. Tries standard parser first,
    then falls back to day-header + time-pair heuristics.
    Always deduplicates by (day, start, end).
    """
    if not ocr_text:
        return []

    # Try standard parser first
    blocks = parse_schedule_text(ocr_text)

    # Also try OCR-specific parsing with day headers
    lines = ocr_text.split("\n")
    course_re = re.compile(r"[A-Z]{2,5}\s*\d{3,5}(?:\s*[-:]\s*\d{1,3})?", re.IGNORECASE)
    time_re = re.compile(r"(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)")
    day_header_re = re.compile(
        r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b", re.IGNORECASE
    )

    current_day = None
    pending_start = None
    ocr_blocks = []

    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue

        day_match = day_header_re.match(line)
        if day_match:
            current_day = DAY_MAP.get(day_match.group(1).lower())
            pending_start = None
            continue

        if not current_day:
            continue

        times = time_re.findall(line)

        # Two times on same line = start and end
        if len(times) >= 2:
            start = parse_time_str(times[0])
            end = parse_time_str(times[1])
            if start and end and start < end:
                name = None
                for offset in [0, -1, -2, 1, 2]:
                    idx = i + offset
                    if 0 <= idx < len(lines):
                        m = course_re.search(lines[idx])
                        if m:
                            name = m.group(0).strip()
                            break
                ocr_blocks.append({"day": current_day, "start": start, "end": end, "name": name or "Class"})
            pending_start = None

        # Single time on a line = start or end
        elif len(times) == 1:
            parsed = parse_time_str(times[0])
            if parsed:
                if pending_start is None:
                    pending_start = parsed
                else:
                    if pending_start < parsed:
                        name = None
                        for offset in range(-3, 3):
                            idx = i + offset
                            if 0 <= idx < len(lines):
                                m = course_re.search(lines[idx])
                                if m:
                                    name = m.group(0).strip()
                                    break
                        ocr_blocks.append({"day": current_day, "start": pending_start, "end": parsed, "name": name or "Class"})
                    pending_start = None

    # Combine and deduplicate by (day, start, end)
    all_blocks = blocks + ocr_blocks
    seen = set()
    unique = []
    for b in all_blocks:
        key = (b["day"], b["start"], b["end"])
        if key not in seen:
            seen.add(key)
            unique.append(b)

    return unique


@app.post("/api/parse-schedule")
def api_parse_schedule():
    """Parse schedule from text input. Accepts JSON body with 'text' field."""
    data = request.get_json(force=True) or {}
    raw_text = data.get("text", "")

    if not raw_text or not isinstance(raw_text, str):
        return jsonify({"ok": False, "error": "No schedule text provided."}), 400

    blocks = parse_schedule_text(raw_text)

    if not blocks:
        return jsonify({
            "ok": True,
            "blocks": [],
            "message": "No schedule entries could be parsed from the provided text.",
            "rawText": raw_text[:2000],
        })

    return jsonify({
        "ok": True,
        "blocks": blocks,
        "count": len(blocks),
    })


@app.post("/api/parse-schedule-image")
def api_parse_schedule_image():
    """Parse schedule from an uploaded image using OCR."""
    if "image" not in request.files:
        return jsonify({"ok": False, "error": "No image file uploaded."}), 400

    file = request.files["image"]
    if not file.filename:
        return jsonify({"ok": False, "error": "Empty filename."}), 400

    image_bytes = file.read()
    if len(image_bytes) > 10 * 1024 * 1024:  # 10MB limit
        return jsonify({"ok": False, "error": "Image too large (max 10MB)."}), 400

    ocr_text, error = parse_schedule_from_image(image_bytes)
    if error:
        return jsonify({"ok": False, "error": error}), 500

    # Use enhanced OCR-specific parser
    blocks = _parse_schedule_blocks_from_ocr(ocr_text)

    return jsonify({
        "ok": True,
        "blocks": blocks,
        "count": len(blocks),
        "ocrText": ocr_text[:3000],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes"}
    app.run(host="0.0.0.0", port=port, debug=debug)
