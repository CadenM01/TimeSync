/**
 * TimeSync CPP Schedule Bookmarklet v2
 *
 * Completely rewritten to match actual CPP page structures:
 * - Schedule Builder: cmsweb.cms.cpp.edu (visual grid with class blocks)
 * - Student Center: my.cpp.edu (text-based schedule with day headers)
 */
(function () {
  "use strict";

  var TIMESYNC_URL = window.TIMESYNC_ORIGIN || "%%TIMESYNC_ORIGIN%%";

  var DAY_NAMES = {
    sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed",
    thursday: "Thu", friday: "Fri", saturday: "Sat",
    sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed",
    thu: "Thu", fri: "Fri", sat: "Sat",
  };

  // Schedule Builder uses column headers: SUN, MON, TUE, WED, THU, FRI, SAT
  var COL_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function parseTime(str) {
    if (!str) return null;
    str = str.trim().replace(/\s+/g, " ");
    // Match: "9:00 am", "09:00 AM", "14:30", "8:30", "9:00am"
    var m = str.match(/(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    var ap = (m[3] || "").toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
  }

  var results = [];

  // ====================================================================
  // STRATEGY 1: Schedule Builder Grid (cmsweb.cms.cpp.edu)
  // The visual calendar has colored blocks positioned in a weekly grid.
  // Each block contains: course code, name, time range, building.
  // Time format inside blocks: "8:30 - 9:45 am" or "1:00 - 2:15 pm"
  // ====================================================================
  function tryScheduleBuilder() {
    // The Schedule Builder renders class blocks as positioned elements.
    // Find ALL elements that contain a time range pattern like "X:XX - X:XX am/pm"
    var allElements = document.querySelectorAll("div, span, td, li, a, p, section, article");
    var timeRangeRe = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*(am|pm)/i;
    var courseRe = /\b(CS|CPE|EE|ME|CE|MAT|PHY|CHM|BIO|ENG|GEO|KIN|MUS|ART|PSY|SOC|COM|ECO|FIN|MGT|MKT|CIS|TOM|AGR|FRL|PLS|ANT|HST)\s*\d{3,5}/i;

    var seen = {};

    allElements.forEach(function (el) {
      var text = el.innerText || el.textContent || "";
      if (!text || text.length > 500 || text.length < 10) return;

      var timeMatch = text.match(timeRangeRe);
      if (!timeMatch) return;

      // Skip if this is a parent that contains many sub-blocks
      var childTimeMatches = 0;
      el.querySelectorAll("div, span").forEach(function (child) {
        if (timeRangeRe.test(child.textContent || "")) childTimeMatches++;
      });
      if (childTimeMatches > 1) return;

      var startRaw = timeMatch[1];
      var endRaw = timeMatch[2];
      var ampm = timeMatch[3];

      // Parse times - both times share the same am/pm unless start > end
      var startH = parseInt(startRaw.split(":")[0], 10);
      var endH = parseInt(endRaw.split(":")[0], 10);

      var startFull, endFull;
      // If end hour < start hour (like 1:00 - 2:15), they share am/pm
      // If start is like 11:XX and end is 12:XX, start is am and end is pm
      if (startH > endH && ampm.toLowerCase() === "pm" && startH <= 12) {
        // e.g., "8:30 - 9:45 am" - both AM
        // e.g., "1:00 - 2:15 pm" - both PM
        startFull = startRaw + " " + ampm;
        endFull = endRaw + " " + ampm;
      } else {
        startFull = startRaw + " " + ampm;
        endFull = endRaw + " " + ampm;
      }

      var start = parseTime(startFull);
      var end = parseTime(endFull);
      if (!start || !end || start >= end) return;

      // Extract course name
      var courseMatch = text.match(courseRe);
      var name = courseMatch ? courseMatch[0].trim() : "Class";

      // Determine which day this block belongs to by its position
      // Get the element's horizontal position relative to the grid
      var rect = el.getBoundingClientRect();
      var centerX = rect.left + rect.width / 2;

      // Find day column headers
      var dayForBlock = determineDayFromPosition(centerX);

      if (dayForBlock) {
        var key = dayForBlock + "|" + start + "|" + end + "|" + name;
        if (!seen[key]) {
          seen[key] = true;
          results.push({ day: dayForBlock, start: start, end: end, name: name });
        }
      }
    });
  }

  function determineDayFromPosition(centerX) {
    // Find day headers in the page to map X positions to days
    var headers = [];
    var allEls = document.querySelectorAll("th, td, div, span");

    allEls.forEach(function (el) {
      var text = (el.innerText || el.textContent || "").trim().toUpperCase();
      if (["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT",
           "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"].indexOf(text) !== -1) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 400) {
          var dayName = text.substring(0, 3);
          dayName = dayName.charAt(0) + dayName.slice(1).toLowerCase();
          headers.push({ day: dayName, left: rect.left, right: rect.right, center: rect.left + rect.width / 2 });
        }
      }
    });

    if (!headers.length) return null;

    // Deduplicate headers by day
    var uniqueHeaders = {};
    headers.forEach(function (h) {
      if (!uniqueHeaders[h.day] || h.right - h.left > uniqueHeaders[h.day].right - uniqueHeaders[h.day].left) {
        uniqueHeaders[h.day] = h;
      }
    });

    var dayList = Object.values(uniqueHeaders).sort(function (a, b) { return a.left - b.left; });
    if (!dayList.length) return null;

    // Find closest day column to the element's center X
    var closest = dayList[0];
    var closestDist = Math.abs(centerX - closest.center);

    for (var i = 1; i < dayList.length; i++) {
      var dist = Math.abs(centerX - dayList[i].center);
      if (dist < closestDist) {
        closest = dayList[i];
        closestDist = dist;
      }
    }

    return closest.day;
  }

  // ====================================================================
  // STRATEGY 2: my.cpp.edu Student Center text format
  // Day headers (Monday, Tuesday, etc.) followed by class entries.
  // Time format: "09:00 am" on one line, "09:50 am" on next line
  // OR: "09:00 am  09:50 am" on same line
  // Course: "CS 4080-01: Concepts of Prgrming Languages"
  // ====================================================================
  function tryStudentCenter() {
    // Grab all visible text
    var bodyText = document.body.innerText || "";
    var lines = bodyText.split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });

    var currentDay = null;
    var pendingStart = null;
    var pendingName = null;
    var timeRe = /^(\d{1,2}:\d{2}\s*(?:am|pm))$/i;
    var timeInlineRe = /(\d{1,2}:\d{2}\s*(?:am|pm))\s+(\d{1,2}:\d{2}\s*(?:am|pm))/i;
    var timeDashRe = /(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i;
    var courseRe = /\b(CS|CPE|EE|ME|CE|MAT|PHY|CHM|BIO|ENG|GEO|KIN|MUS|ART|PSY|SOC|COM|ECO|FIN|MGT|MKT|CIS|TOM|AGR|FRL|PLS|ANT|HST)\s*\d{3,5}(?:\s*[-:]\s*\d{1,3})?/i;
    // Match day headers with optional surrounding markers: __Monday__, *Monday*, - Monday -, etc.
    var dayHeaderRe = /^[_*\s`>#\-]*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[_*\s`>#\-]*$/i;
    var ignoredPrefixes = ["building:", "room:", "location:", "instructor:"];
    var ignoredExact = ["hybrid synchronous", "hybrid asynchronous", "synchronous", "asynchronous", "online", "hybrid"];
    var seen = {};

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineLower = line.toLowerCase();

      // Check for day headers (e.g. "Monday", "__Monday__", "*Monday*")
      var dayHeaderMatch = line.match(dayHeaderRe);
      if (dayHeaderMatch) {
        currentDay = DAY_NAMES[dayHeaderMatch[1].toLowerCase()];
        pendingStart = null;
        pendingName = null;
        continue;
      }
      // Also match bare day names at start of line (fallback)
      for (var dayName in DAY_NAMES) {
        if (lineLower === dayName || (lineLower.indexOf(dayName) === 0 && lineLower.length < dayName.length + 3)) {
          currentDay = DAY_NAMES[dayName];
          pendingStart = null;
          pendingName = null;
          break;
        }
      }

      if (!currentDay) continue;

      // Skip building/room/instructor/hybrid lines (same as backend parser)
      var isIgnored = false;
      for (var ip = 0; ip < ignoredPrefixes.length; ip++) {
        if (lineLower.indexOf(ignoredPrefixes[ip]) === 0) { isIgnored = true; break; }
      }
      if (!isIgnored && ignoredExact.indexOf(lineLower) !== -1) isIgnored = true;
      if (isIgnored) continue;

      // Check for inline time pair: "09:00 am  09:50 am" or with dash
      var inlineMatch = line.match(timeInlineRe);
      if (!inlineMatch) inlineMatch = line.match(timeDashRe);

      if (inlineMatch) {
        var s = parseTime(inlineMatch[1]);
        var e = parseTime(inlineMatch[2]);
        if (s && e && s < e) {
          // Look for course name nearby
          var name = null;
          for (var j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
            var cm = lines[j].match(courseRe);
            if (cm) { name = cm[0]; break; }
          }
          var key = currentDay + "|" + s + "|" + e;
          if (!seen[key]) {
            seen[key] = true;
            results.push({ day: currentDay, start: s, end: e, name: name || "Class" });
          }
        }
        pendingStart = null;
        continue;
      }

      // Check for standalone time (start/end on separate lines)
      // CPP format: "09:00 am" then "09:50 am"
      var standaloneMatch = line.match(timeRe);
      if (standaloneMatch) {
        var parsedTime = parseTime(standaloneMatch[1]);
        if (parsedTime) {
          if (!pendingStart) {
            pendingStart = parsedTime;
            // Look for course name in nearby lines
            pendingName = null;
            for (var k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
              var cm2 = lines[k].match(courseRe);
              if (cm2) { pendingName = cm2[0]; break; }
            }
          } else {
            // This is the end time
            if (pendingStart < parsedTime) {
              var key2 = currentDay + "|" + pendingStart + "|" + parsedTime;
              if (!seen[key2]) {
                seen[key2] = true;
                results.push({
                  day: currentDay,
                  start: pendingStart,
                  end: parsedTime,
                  name: pendingName || "Class",
                });
              }
            }
            pendingStart = null;
            pendingName = null;
          }
        }
        continue;
      }

      // Check for times embedded in a longer line (e.g., "09:00 am CS 4080...")
      var embeddedTimes = line.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/gi);
      if (embeddedTimes && embeddedTimes.length >= 2) {
        var s2 = parseTime(embeddedTimes[0]);
        var e2 = parseTime(embeddedTimes[1]);
        if (s2 && e2 && s2 < e2) {
          var cm3 = line.match(courseRe);
          var key3 = currentDay + "|" + s2 + "|" + e2;
          if (!seen[key3]) {
            seen[key3] = true;
            results.push({ day: currentDay, start: s2, end: e2, name: cm3 ? cm3[0] : "Class" });
          }
        }
        pendingStart = null;
        continue;
      }

      // If line has a course name, remember it for the next time pair
      var courseOnlyMatch = line.match(courseRe);
      if (courseOnlyMatch && !standaloneMatch) {
        pendingName = courseOnlyMatch[0];
      }
    }
  }

  // ====================================================================
  // STRATEGY 3: Generic fallback - find ALL time patterns on the page
  // and associate them with the nearest day context
  // ====================================================================
  function tryGenericScrape() {
    var bodyText = document.body.innerText || "";
    var lines = bodyText.split("\n").map(function (l) { return l.trim(); });
    var currentDay = null;
    var courseRe = /\b(CS|CPE|EE|ME|CE|MAT|PHY|CHM|BIO|ENG|GEO|KIN|MUS|ART|PSY|SOC|COM|ECO|FIN|MGT|MKT|CIS|TOM)\s*\d{3,5}/i;
    var seen = {};

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineLower = line.toLowerCase().trim();

      for (var dayName in DAY_NAMES) {
        if (lineLower === dayName) {
          currentDay = DAY_NAMES[dayName];
        }
      }

      if (!currentDay) continue;

      // Find any two times on the same line
      var allTimes = line.match(/\d{1,2}:\d{2}\s*(?:am|pm)?/gi);
      if (allTimes && allTimes.length >= 2) {
        var s = parseTime(allTimes[0]);
        var e = parseTime(allTimes[1]);
        if (s && e && s < e) {
          var cm = line.match(courseRe);
          // Also look in previous 2 lines for course name
          if (!cm) {
            for (var p = Math.max(0, i - 2); p < i; p++) {
              cm = lines[p].match(courseRe);
              if (cm) break;
            }
          }
          var key = currentDay + "|" + s + "|" + e;
          if (!seen[key]) {
            seen[key] = true;
            results.push({ day: currentDay, start: s, end: e, name: cm ? cm[0] : "Class" });
          }
        }
      }
    }
  }

  // Run strategies - try all of them and combine results
  tryScheduleBuilder();
  tryStudentCenter();
  if (results.length < 3) {
    tryGenericScrape();
  }

  // Deduplicate
  var seen2 = {};
  var unique = [];
  results.forEach(function (r) {
    var key = r.day + "|" + r.start + "|" + r.end;
    if (!seen2[key]) {
      seen2[key] = true;
      unique.push(r);
    }
  });

  if (!unique.length) {
    // Last resort: dump page text and suggest paste approach
    var pageText = (document.body.innerText || "").substring(0, 5000);
    var msg = "TimeSync: Could not automatically extract schedule data.\n\n" +
      "Try this instead:\n" +
      "1. Select all the schedule text on this page (Cmd+A or Ctrl+A)\n" +
      "2. Copy it (Cmd+C or Ctrl+C)\n" +
      "3. Go to TimeSync and use 'Import Schedule > Paste Text'\n" +
      "4. Paste and click 'Parse Schedule'\n\n" +
      "Page text has been copied to your clipboard for convenience.";

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pageText).then(function () {
        alert(msg);
        window.open(TIMESYNC_URL + "?import_clipboard=1", "_blank");
      }).catch(function () {
        alert(msg);
      });
    } else {
      alert(msg);
    }
    return;
  }

  // Send to TimeSync
  var encoded = encodeURIComponent(JSON.stringify(unique));
  var url = TIMESYNC_URL + "?import_schedule=" + encoded;

  if (url.length > 8000) {
    var jsonStr = JSON.stringify(unique, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(jsonStr).then(function () {
        alert(
          "TimeSync: Found " + unique.length + " class blocks!\n\n" +
          "Data copied to clipboard. Opening TimeSync...\n" +
          "Use Import Schedule > Paste Text to import."
        );
        window.open(TIMESYNC_URL + "?import_clipboard=1", "_blank");
      });
    } else {
      alert("TimeSync: Found " + unique.length + " blocks. Opening TimeSync...");
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }
})();
