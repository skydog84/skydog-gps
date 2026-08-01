"""Run 3 owner report - built from SKYDOG_PDF_REPORT_TEMPLATE.py (do not redesign)."""

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

DATE_ISO = "2026-08-01"
DATE_LONG = "Saturday, August 1, 2026 (evening)"
OUT = "SkyDog_GPS_Run3_HuntIntel_Report_%s.pdf" % DATE_ISO

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
st_head    = S("th", fontSize=8.5, leading=11, fontName="Helvetica-Bold", textColor=colors.white)
st_note    = S("n",  fontSize=10, leading=14, textColor=colors.HexColor("#6b4a05"))
st_big     = S("bg", fontName="Helvetica-Bold", fontSize=14, leading=19, textColor=INK, spaceAfter=8)

def rule(sp_before=4, sp_after=10):
    return [Spacer(1, sp_before), HRFlowable(width="100%", thickness=0.7, color=RULE), Spacer(1, sp_after)]

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

FOOTER_TEXT = "SkyDog GPS  ·  Run 3: Hunt Intelligence  ·  " + DATE_LONG

def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(GREEN)
    canvas.rect(0, letter[1] - 0.34 * inch, letter[0], 0.34 * inch, stroke=0, fill=1)
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
                      title="SkyDog GPS - Run 3 Report - %s" % DATE_ISO,
                      author="SkyDog AI", subject="Hunt Intelligence shipped")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

W = doc.width
story = []

story += [
    Paragraph("SkyDog GPS — Run 3 Report", st_title),
    Paragraph(DATE_LONG + "  ·  Hunt Intelligence is LIVE", st_sub),
]
story += rule(6, 14)

story += [Paragraph(
    "Your app now does something no hunting app in America does at any price: it models "
    "the thermals on your actual hillside, tells you which hours the wind is right for each "
    "of your stands, and walks you through recovering a hit deer with one thumb at 2am. "
    "It went live on skydoggps.com tonight, v1.5, with every test passing (408 of 408). "
    "The competition charges $30–100 a year for less. You charge $2.99 a month.", st_big)]
story += [Spacer(1, 6)]

story += section("What got done today")
story += [datatable([
    ["AREA", "OUTCOME"],
    ["<b>Wind per stand</b>",
     "Edit any saved spot and tap the wind directions it hunts well on (a 16-point compass). "
     "SkyDog then reads the 48-hour forecast and lists the exact huntable windows — and "
     "draws a blue scent cone on the map showing where your smell is blowing. Part of All Access ($2.99)."],
    ["<b>Thermals — a first</b>",
     "Using free government elevation data, SkyDog measures the slope under each stand and "
     "calls morning rising / evening dropping thermals, adjusted for cloud cover. HuntWise and "
     "onX only write blog posts about thermals — nobody ships this. You do now."],
    ["<b>Recovery Mode</b>",
     "Free for every hunter. Mark the shot, then giant Blood / Hair / Lost-Trail buttons build the "
     "trail on the map, show which way he's heading, and lay a spiral search grid when blood runs out. "
     "Wait-time guidance (heart / liver / gut) from standard bowhunter education, plus a one-tap link "
     "to tracking-dog directories. This is the feature that earns 'SkyDog found my buck' reviews."],
    ["<b>Safety email fixed</b>",
     "The overdue-timer email system from last night wasn't actually armed — the account, the "
     "domain records and the secret key were all missing. We fixed it together tonight: domain added, "
     "records placed, key created. One paste from you finishes it (below)."],
    ["<b>Quality</b>",
     "37 new automated tests (408 total, all passing). New version pushed live. Nothing uploaded "
     "anywhere: your stand locations never leave your phone — your call, and the right one."],
], [1.62 * inch, W - 1.62 * inch])]
story += [Spacer(1, 16)]

story += section("Where things actually stand")
story += [datatable([
    ["GATE", "STATUS", "WHO IT'S ON"],
    ["Web app v1.5 (Run 3)", "LIVE on skydoggps.com", "Done"],
    ["Overdue safety email", "One paste-command left", "You (2 minutes)"],
    ["Google Play identity check", "Still in Google's queue", "Google"],
    ["Android testers (need 15)", "Recruiting", "You — the only clock you control"],
    ["iOS v1.1", "Waiting for Apple review", "Apple — do not touch"],
    ["what3words key", "Optional, still open", "You, whenever"],
], [2.15 * inch, 1.95 * inch, W - 4.10 * inch])]
story += [Spacer(1, 12)]
story += [callout("The one 2-minute job left tonight",
    "In the Resend window: click the little copy icon next to the hidden API key, then tell Claude "
    "“copied” in the chat. Claude pipes it straight from your clipboard into the server vault — "
    "the key never appears on screen or in the chat. The moment it lands, the safety-email test that is "
    "already queued will send itself to your inbox and prove the whole chain works.")]
story += [Spacer(1, 18)]

story += section("What to expect, and when")
story += [datatable([
    ["WHEN", "WHAT HAPPENS"],
    ["Tonight", "Paste the key → within ~20 minutes a test safety email lands in skydog8426@gmail.com. "
                "That is a dead phone telling someone where you are — working, end to end."],
    ["Next session (Run 4)", "Trail Cam Hub: every camera brand, one map, no per-camera fees. The biggest "
                "build of the five — it anchors the whole $2.99 story."],
    ["When Google clears you", "Create the Play listing (mostly copy-paste, one sitting), upload the app, "
                "start the 14-day closed test the day the 12th tester opts in."],
], [1.62 * inch, W - 1.62 * inch])]
story += [Spacer(1, 18)]

story += section("The only things that are actually yours right now")
story += bullets([
    "<b>Copy that API key</b> in the Resend window and say “copied” — 2 minutes, arms the safety emails.",
    "<b>Keep recruiting Android testers</b> — skydoggps.com/testers. Fifteen names; the 14-day clock "
    "can't start without them, no matter what Google does.",
])
story += [Spacer(1, 16)]

story += section("Worth keeping in mind")
story += bullets([
    "<b>Thermals are modeled, not measured</b> — the app says so on the sheet. Honesty is the brand; "
    "a hunter's milkweed puff always outranks any app, including yours.",
    "<b>Stand privacy is a selling point.</b> You chose to keep stand locations off every server — "
    "that's a line the $100/yr apps can't say. Worth putting in your marketing.",
    "<b>Recovery Mode is free on purpose.</b> Every 'found my buck' story is a five-star review and three "
    "word-of-mouth downloads. The $2.99 tier sells itself off the wind and thermals.",
])

doc.build(story)
print("BUILT", OUT)
