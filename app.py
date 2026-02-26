import os
from datetime import datetime, timezone
from uuid import uuid4

from flask import Flask, jsonify, render_template, request
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

app = Flask(__name__)

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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


def ensure_indexes():
    global _indexes_initialized
    if _indexes_initialized:
        return
    col = schedules_collection()
    if col is None:
        return
    col.create_index("userKey", unique=True)
    _indexes_initialized = True


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


@app.get("/")
def index():
    return render_template("index.html")


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


@app.get("/api/profiles/<user_key>")
def get_profile(user_key):
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
    return jsonify({"ok": True, **profile})


@app.post("/api/profiles/<user_key>")
def save_profile(user_key):
    unavailable = db_unavailable_response()
    if unavailable:
        return unavailable

    key = normalize_user_key(user_key)
    if not key:
        return jsonify({"ok": False, "error": "user_key is required"}), 400

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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes"}
    app.run(host="0.0.0.0", port=port, debug=debug)
