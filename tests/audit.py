import re, sys

KNOWN_DYNAMIC = {
  'chkBackwashed','chkSaltCell','colorGrid','colorCancel','fieldAlertOk','alertOk',
  'camPreview','camCancel','camShutter','camFlip','trDate','trOnce','trAlways','trCancel',
  'ruleList','ruleAdd','ruleDone','ruleMimicRow','ruleMimicOn','ruleMimicSource','ruleMimicNote',
  'histPhotoClose','rsDate','rsOnce','rsAlways','rsCancel','anClose','quickButtonsBody',
  'skipReasonText','skipPhotoBtn','skipPhotoInput','skipPhotoWrap','skipPhotoPreview',
  'skipPhotoRemove','skipReasonSave','skipReasonCancel','photoTechList','photoTechDone',
  'wcProductSuggestions','psCategoryPick','globalHistList','globalHistCount',
  'importMapBody','importPreview','importGo','importCancel',
}

issues = 0
for f in ['customer-intake.html','technician-app.html','admin-readings-app.html']:
    src = open(f).read()

    if '</html>' not in src:
        print('CRITICAL: %s is truncated' % f); issues += 1; continue

    scripts = re.findall(r'<script>(.*?)</script>', src, re.S)
    if len(scripts) != 1:
        print('CRITICAL: %s has %d inline script blocks' % (f, len(scripts))); issues += 1


    # A view nested inside another view is invisible — this exact break shipped
    # once, taking Products and Services and Route Scheduling down with it.
    body = src[src.find('<body>'):src.find('</body>')]
    opens = len(re.findall(r'<div\b', body))
    closes = len(re.findall(r'</div>', body))
    if opens != closes:
        print('CRITICAL: %s has unbalanced divs (%d open, %d closed)' % (f, opens, closes))
        issues += 1

    depth = 0
    depths = []
    for m in re.finditer(r'<div\b[^>]*>|</div>', body):
        tag = m.group(0)
        if tag.startswith('</'):
            depth -= 1
        else:
            depth += 1
            vm = re.search(r'id="(view-[^"]+)"', tag)
            if vm:
                depths.append((vm.group(1), depth))
    if depths:
        want = depths[0][1]
        for name, d in depths:
            if d != want:
                print('CRITICAL: %s view "%s" is nested inside another view' % (f, name))
                issues += 1

    ids = re.findall(r'id="([^"]+)"', src)
    dupes = {i for i in ids if ids.count(i) > 1}
    for d in dupes:
        print('DUPLICATE id "%s" in %s' % (d, f)); issues += 1

    declared = set(ids)
    referenced = set(re.findall(r"getElementById\('([^']+)'\)", src))
    for m in sorted(referenced - declared):
        if m in KNOWN_DYNAMIC: continue
        if re.match(r'^(pool|spa|fountain)_', m): continue
        print('MISSING element: getElementById(\'%s\') in %s has no matching id' % (m, f))
        issues += 1

print('TOTAL HARD ISSUES: %d' % issues)
sys.exit(1 if issues else 0)
