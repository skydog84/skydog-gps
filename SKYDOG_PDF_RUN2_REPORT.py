"""
SKYDOG DAY-REPORT PDF TEMPLATE  --  DO NOT REDESIGN.

Standing instruction from the owner (2026-08-01):
every handoff ships with a matching PDF, formatted exactly like this one.

HOW TO USE
  1. Copy this file (do not edit it in place).
  2. Set DATE_ISO / DATE_LONG at the top.
  3. Replace everything below the "STORY CONTENT" banner with the new day's material.
  4. python3 <yourcopy>.py
  5. SendUserFile the PDF, and write it to the Mac alongside the handoff.

THE FOUR SECTIONS, IN ORDER -- keep this shape:
  1. One bold paragraph: the single most important thing that changed today.
  2. "What got done today"                -> datatable(AREA / OUTCOME)
  3. "Where the account actually stands"  -> datatable(GATE / STATUS / WHO IT'S ON)
  4. "What to expect, and when"           -> datatable(WHEN / WHAT HAPPENS)
  5. "The only thing that's actually yours right now" -> bullets()
  6. "Worth keeping in mind"              -> bullets()
  Use callout() for corrections and warnings that must not be skimmed past.

VOICE: plain language, no jargon, money and consequences explained before terminology.
The handoff is for the next assistant. THIS is for the owner. Never just print the handoff.

BUILDING BLOCKS AVAILABLE
  section(title)                     -> green section heading
  datatable(rows, widths)            -> green header row, zebra striping, first row = headers
  bullets([...])                     -> bulleted list, inline <b> allowed
  callout(title, body)               -> amber warning box
  rule(), Spacer(1, n), Paragraph(t, st_body / st_big)
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, HRFlowable)

GREEN     = colors.HexColor("#1d7a41")
GREEN_LT  = colors.HexColor("#e8f5ec")
INK       = colors.HexColor("#1a1d1a")
DIM       = colors.HexColor("#5c6660")
RULE      = colors.HexColor("#d4ddd7")
AMBER     = colors.HexColor("#9a6708")
AMBER_LT  = colors.HexColor("#fdf4e3")

import sys, datetime
# Usage: python3 SKYDOG_PDF_REPORT_TEMPLATE.py [YYYY-MM-DD]
DATE_ISO = "2026-08-01_Run2"
DATE_LONG = "Saturday, August 1, 2026 - Run 2"
OUT = "SkyDog_GPS_Run2_WorldData_Report_2026-08-01.pdf"

# ---------- styles ----------
def S(name, **kw):
    base = dict(name=name, fontName="Helvetica", fontSize=10.5, leading=15,
                textColor=INK, alignment=TA_LEFT, spaceAfter=0)
    base.update(kw)
    return ParagraphStyle(**base)

st_title   = S("t",  fontName="Helvetica-Bold", fontSize=25, leading=29, textColor=INK, spaceAfter=3)
st_sub     = S("s",  fontSize=11.5, leading=15, textColor=DIM, spaceAfter=2)
st_h       = S("h",  fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=GREEN, spaceAfter=7)
st_body    = S("b",  spaceAfter=8)
st_bullet  = S("bu", leftIndent=15, bulletIndent=3, spaceAfter=5)
st_cell    = S("c",  fontSize=10, leading=13.5)
st_cellb   = S("cb", fontSize=10, leading=13.5, fontName="Helvetica-Bold")
st_head    = S("th", fontSize=8.5, leading=11, fontName="Helvetica-Bold",
               textColor=colors.white)
st_note    = S("n",  fontSize=10, leading=14, textColor=colors.HexColor("#6b4a05"))
st_big     = S("bg", fontName="Helvetica-Bold", fontSize=14, leading=19, textColor=INK,
               spaceAfter=8)

def rule(sp_before=4, sp_after=10):
    return [Spacer(1, sp_before), HRFlowable(width="100%", thickness=0.7, color=RULE),
            Spacer(1, sp_after)]

def section(title):
    return [Paragraph(title, st_h)]

def bullets(items, style=st_bullet):
    return [Paragraph(t, style, bulletText="•") for t in items]

def datatable(rows, widths, header=True, zebra=True):
    data = []
    for i, r in enumerate(rows):
        if header and i == 0:
            data.append([Paragraph(c, st_head) for c in r])
        else:
            data.append([Paragraph(c, st_cell) for c in r])
    t = Table(data, colWidths=widths, hAlign="LEFT")
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, RULE),
        ("BOX", (0, 0), (-1, -1), 0.7, RULE),
    ]
    if header:
        cmds.append(("BACKGROUND", (0, 0), (-1, 0), GREEN))
    if zebra:
        start = 1 if header else 0
        for i in range(start, len(data)):
            if (i - start) % 2 == 1:
                cmds.append(("BACKGROUND", (0, i), (-1, i), GREEN_LT))
    t.setStyle(TableStyle(cmds))
    return t

def callout(title, body):
    inner = [Paragraph("<b>%s</b>" % title, S("ct", fontName="Helvetica-Bold",
             fontSize=11, leading=14, textColor=AMBER, spaceAfter=4)),
             Paragraph(body, st_note)]
    t = Table([[inner]], colWidths=[6.9 * inch], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), AMBER_LT),
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#e0c37a")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    return t

FOOTER_TEXT = "SkyDog GPS  -  Run 2: Free Data Flex  -  " + DATE_LONG

# ---------- page furniture ----------
def decorate(canvas, doc):
    canvas.saveState()
    # top accent bar
    canvas.setFillColor(GREEN)
    canvas.rect(0, letter[1] - 0.34 * inch, letter[0], 0.34 * inch, stroke=0, fill=1)
    # footer
    canvas.setFillColor(DIM)
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(0.85 * inch, 0.52 * inch, FOOTER_TEXT)
    canvas.drawRightString(letter[0] - 0.85 * inch, 0.52 * inch, "Page %d" % doc.page)
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.6)
    canvas.line(0.85 * inch, 0.72 * inch, letter[0] - 0.85 * inch, 0.72 * inch)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=letter,
                      leftMargin=0.85 * inch, rightMargin=0.85 * inch,
                      topMargin=0.78 * inch, bottomMargin=0.95 * inch,
                      title="SkyDog GPS - Day Report - %s" % DATE_ISO,
                      author="SkyDog AI", subject="Google Play progress and plan")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])


W = doc.width
story = []

# ==========================================================================
#  STORY CONTENT  --  replace everything below this line each time.
#  What follows is the 2026-08-01 report, kept as a worked example.
# ==========================================================================

story += [
    Paragraph("SkyDog GPS \u2014 Run 2 Report", st_title),
    Paragraph(DATE_LONG + "  \u00b7  World Data + auto-email safety net", st_sub),
]
story += rule(6, 14)

story += [Paragraph(
    "Your app now shows live storm radar, official weather alerts, river flows and wildfire "
    "perimeters \u2014 the exact layers the $100-a-year apps charge for \u2014 free, on the map tonight. "
    "And the safety timer grew its biggest tooth yet: with one switch, a phone that dies in the woods "
    "can still get you looked for.", st_big)]
story += [Spacer(1, 6)]

story += section("What got done today")
story += [datatable([
    ["AREA", "OUTCOME"],
    ["<b>Cloud server</b>", "Your Cloudflare worker is DEPLOYED and live (you logged in, it deployed clean, "
     "we tested it round-trip). This was the homework blocking half the future roadmap \u2014 done."],
    ["<b>Storm radar</b>", "Animated NOAA radar (last hour) on the map under the new globe button on the wheel. "
     "Free for everyone with ads. Competitors lock this behind $100/yr."],
    ["<b>Weather alerts</b>", "Official National Weather Service warnings listed and drawn on the map \u2014 "
     "including marine warnings for boaters, which almost nobody serves. If a warning covers YOUR position, "
     "a red pill pops up and the phone buzzes."],
    ["<b>River gauges</b>", "Live USGS flow, height and water temp on 10,000+ gauges. Pins free for everyone; "
     "the 7-day trend detail sheet is an All Access perk (your call #3, built exactly that way)."],
    ["<b>Wildfire</b>", "Active fire perimeters from the National Interagency Fire Center, free. If the data "
     "gets old because you lost signal, a loud STALE warning appears \u2014 stale fire data presented as fresh "
     "is dangerous, so honesty is enforced by a test."],
    ["<b>Dead-phone safety net</b>", "New opt-in switch on the Back-by timer: if your phone goes silent past "
     "your back-by time, the server emails your contacts \u2014 plan, due time, last position \u2014 even if the "
     "phone is dead in a ravine. Off by default, plain-language privacy copy, records self-destruct."],
    ["<b>Tests</b>", "371 of 371 passing (up from 329). Site pushed live: v1.4."],
], [1.62 * inch, W - 1.62 * inch])]
story += [Spacer(1, 16)]

story += section("Where things actually stand")
story += [datatable([
    ["GATE", "STATUS", "WHO IT'S ON"],
    ["Web app v1.4", "LIVE at skydoggps.com", "Done"],
    ["Cloud worker", "Deployed + tested, running its safety sweep every 10 min", "Done"],
    ["Auto-email sending", "Built and waiting on ONE errand: a free Resend account (steps below)", "You (15 min)"],
    ["what3words on SOS", "Still waiting on your free key \u2014 app is ready, paste and go", "You (10 min)"],
    ["Google Play", "Unchanged tonight \u2014 still identity verification + testers", "Google / you"],
    ["iOS v1.1", "Still Waiting for Review \u2014 not touched, on purpose", "Apple"],
], [2.15 * inch, 2.6 * inch, W - 4.75 * inch])]
story += [Spacer(1, 12)]
story += [callout("The one thing standing between today and the full dead-phone safety net",
    "The email service the plan counted on (MailChannels) killed its free tier in 2024 \u2014 verified tonight. "
    "The replacement is Resend: free, 100 emails/day, more than enough. The 15-minute errand: "
    "1) create a free account at resend.com with skydog8426@gmail.com; 2) add the domain skydogai.com there and "
    "copy the DNS records it shows into your Cloudflare dashboard (that domain is already in your account); "
    "3) tell the next session the API key is ready and it gets wired in with one command. Until then everything "
    "else works \u2014 the phone-side alarm and text button never needed a server.")]
story += [Spacer(1, 18)]

story += section("What this means for money")
story += bullets([
    "<b>The pitch got sharper.</b> Radar, alerts, river data and wildfire \u2014 all free \u2014 is the "
    "\u201ceverything they paywall\u201d story, live on the site. onX charges $100/yr for radar.",
    "<b>All of it runs on free government data + free-tier infrastructure.</b> Monthly cost of Run 2: $0. "
    "The one paid perk (river detail sheets) rides the existing $2.99 All Access \u2014 no new products, no new fees.",
    "<b>The safety story is now a category of its own.</b> No $2.99 app has an auto-email dead-phone net. "
    "That is a screenshot, a review magnet, and a reason to tell a friend.",
])
story += [Spacer(1, 16)]

story += section("Worth keeping in mind")
story += bullets([
    "<b>Auto-email is opt-in and honest.</b> Contacts stay on the phone unless the user flips the switch; "
    "the privacy policy was updated tonight to match, word for word.",
    "<b>Nothing native was touched.</b> iOS stays safely in review; the next Android build picks up "
    "Runs 1 and 2 automatically.",
    "<b>Deferred on purpose (allowed by the plan):</b> cell-coverage tiles (needs a data-crunching job on the "
    "Mac), satellite fire hotspots + air quality (need two free API keys), light-pollution layer. "
    "None of them block anything.",
])

doc.build(story)
print("BUILT", OUT)
