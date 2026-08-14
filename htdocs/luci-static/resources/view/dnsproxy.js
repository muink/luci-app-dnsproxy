'use strict';
'require form';
'require fs';
'require uci';
'require rpc';
'require poll';
'require ui';
'require view';
'require tools.widgets as widgets';

const conf = 'dnsproxy';
const instance = 'dnsproxy';
const profileListOptions = ['bootstrap', 'upstream', 'fallback'];
const upstreamModes = ['load_balance', 'parallel', 'fastest_addr'];
const testDomainStorageKey = 'luci.dnsproxy.profileTestDomain';

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList(conf), {})
		.then((res) => {
			let isrunning = false;
			try {
				isrunning = res[conf]['instances'][instance]['running'];
			} catch (e) { }
			return isrunning;
		});
}

function profileTitle(profile) {
	return profile.label || profile['.name'];
}

function normalizedList(value) {
	return L.toArray(value).map((item) => String(item).trim()).filter(Boolean);
}

function currentUpstreamMode() {
	return uci.get(conf, 'global', 'upstream_mode') ||
		(uci.get(conf, 'global', 'fastest_addr') === '1' ? 'fastest_addr' : null) ||
		(uci.get(conf, 'global', 'all_servers') === '1' ? 'parallel' : 'load_balance');
}

function profileData(profile) {
	return {
		label: profileTitle(profile).trim(),
		bootstrap: normalizedList(profile.bootstrap),
		upstream: normalizedList(profile.upstream),
		fallback: normalizedList(profile.fallback),
		upstream_mode: upstreamModes.includes(profile.upstream_mode) ? profile.upstream_mode : ''
	};
}

function listsEqual(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function profileMatches(profile, settings) {
	const data = profileData(profile);
	const listsMatch = profileListOptions.every((option) => listsEqual(data[option], settings[option]));
	return listsMatch && (!data.upstream_mode || data.upstream_mode === settings.upstream_mode);
}

function activeProfile(profiles) {
	const settings = {
		bootstrap: normalizedList(uci.get(conf, 'servers', 'bootstrap')),
		upstream: normalizedList(uci.get(conf, 'servers', 'upstream')),
		fallback: normalizedList(uci.get(conf, 'servers', 'fallback')),
		upstream_mode: currentUpstreamMode()
	};

	return profiles.find((profile) => profileMatches(profile, settings));
}

function validateServerValue(section_id, value) {
	if (!value)
		return true;

	if (value !== value.trim())
		return _('DNS server values must not begin or end with whitespace.');

	if (value.length > 2048)
		return _('DNS server values must not exceed 2048 characters.');

	if (/[\u0000-\u001f\u007f]/.test(value))
		return _('DNS server values must not contain control characters.');

	return true;
}

function validateUniqueServerValue(listName) {
	return function (section_id, value) {
		const result = validateServerValue(section_id, value);
		if (result !== true)
			return result;

		const widget = this.getUIElement(section_id);
		const values = normalizedList(widget ? widget.getValue() : value);
		if (new Set(values).size !== values.length)
			return _('Duplicate DNS server in %s.').format(listName);

		return true;
	};
}

function validateTestDomain(value) {
	const domain = String(value || '').trim();
	const hostname = domain.endsWith('.') ? domain.slice(0, -1) : domain;

	if (!hostname)
		return _('Test domain is required.');

	if (hostname.length > 253)
		return _('Test domain must not exceed 253 characters.');

	if (!/^[A-Za-z0-9.-]+$/.test(hostname))
		return _('Enter an ASCII domain name, for example example.com. International domains must use Punycode.');

	if (hostname.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))
		return _('Test domain contains an invalid DNS label.');

	return true;
}

function storedTestDomain() {
	try {
		const value = window.localStorage.getItem(testDomainStorageKey);
		return validateTestDomain(value) === true ? String(value).trim() : 'openwrt.org';
	} catch (e) {
		return 'openwrt.org';
	}
}

function rememberTestDomain(value) {
	try {
		window.localStorage.setItem(testDomainStorageKey, value);
	} catch (e) { }
}

function analyzeProfile(data, profiles, sectionName) {
	const errors = [];
	const warnings = [];
	const label = String(data.label || '').trim();

	if (!label)
		errors.push(_('Profile name is required.'));
	else if (label.length > 64)
		errors.push(_('Profile name must not exceed 64 characters.'));
	else if (profiles.some((profile) => profile['.name'] !== sectionName && profileTitle(profile).trim().toLowerCase() === label.toLowerCase()))
		errors.push(_('Profile names must be unique.'));

	if (!data.upstream.length)
		errors.push(_('At least one upstream DNS server is required.'));

	profileListOptions.forEach((option) => {
		const seen = new Set();
		data[option].forEach((value) => {
			const result = validateServerValue(null, value);
			if (result !== true)
				errors.push(result);
			if (seen.has(value))
				errors.push(_('Duplicate DNS server in %s.').format(option));
			seen.add(value);
		});
	});

	if (data.upstream_mode && !upstreamModes.includes(data.upstream_mode))
		errors.push(_('Unsupported upstream selection mode.'));

	if (!data.bootstrap.length && data.upstream.some((value) => /^(?:https|h3|tls|quic):\/\/[A-Za-z]/i.test(value)))
		warnings.push(_('No bootstrap DNS server is set. System resolvers will be used for encrypted upstream hostnames.'));

	return { errors, warnings };
}

function showProfileProblems(result) {
	result.errors.forEach((message) => ui.addNotification(null, E('p', {}, message), 'error'));
	result.warnings.forEach((message) => ui.addNotification(null, E('p', {}, message), 'warning'));
	return result.errors.length === 0;
}

function setProfileValues(sectionName, data) {
	uci.set(conf, sectionName, 'label', data.label);
	profileListOptions.forEach((option) => uci.set(conf, sectionName, option, data[option].length ? data[option] : null));
	uci.set(conf, sectionName, 'upstream_mode', data.upstream_mode || null);
}

function exportProfiles(profiles, filename) {
	const payload = {
		version: 1,
		profiles: profiles.map((profile) => profileData(profile))
	};
	const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = E('a', { 'href': url, 'download': filename });

	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importedProfileData(profile) {
	return {
		label: String(profile?.label || '').trim(),
		bootstrap: normalizedList(profile?.bootstrap),
		upstream: normalizedList(profile?.upstream),
		fallback: normalizedList(profile?.fallback),
		upstream_mode: String(profile?.upstream_mode || '')
	};
}

return view.extend({

	load() {
	return Promise.all([
		getServiceStatus(),
		callHostHints(),
		uci.load('dnsproxy')
	]);
	},

	poll_status(nodes, stat) {
		const isRunning = stat[0];
		let view = nodes.querySelector('#service_status');

		if (isRunning) {
			view.innerHTML = "<span style=\"color:green;font-weight:bold\">" + instance + " - " + _("SERVER RUNNING") + "</span>";
		} else {
			view.innerHTML = "<span style=\"color:red;font-weight:bold\">" + instance + " - " + _("SERVER NOT RUNNING") + "</span>";
		}
		return;
	},

	render(res) {
		const isRunning = res[0];
		const hosts = res[1];
		const serverOptions = {};
		let upstreamModeOption;

		let m, s, o, ss, so;

		m = new form.Map('dnsproxy', _('DNS Proxy'));

		s = m.section(form.NamedSection, '_status');
		s.render = function (section_id) {
			return E('div', { class: 'cbi-section' }, [
				E('div', { id: 'service_status' }, _('Collecting data ...'))
			]);
		};

		s = m.section(form.NamedSection, 'global', 'dnsproxy');

		s.tab('main', _('Main'));

		o = s.taboption('main', form.Flag, 'enabled', _('Enable'));
		o.default = o.disabled;

		o = s.taboption('main', form.Flag, 'verbose', _('Verbose'));

		o = s.taboption('main', form.Value, 'log_file', _('Log file path'));
		o.datatype = 'file';

		o = s.taboption('main', form.DynamicList, 'listen_addr', _('Listen address'));
		o.datatype = "list(ipaddr(1))";
		o.value('127.0.0.1');
		o.value('::1');

		let ipaddrs = {}, ip6addrs = {};
		for (let mac in hosts) {
			let addrs = L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4);
			let addrs6 = L.toArray(hosts[mac].ip6addrs || hosts[mac].ipv6);

			for (let i = 0; i < addrs.length; i++)
				ipaddrs[addrs[i]] = hosts[mac].name || mac;
			for (let i = 0; i < addrs6.length; i++)
				ip6addrs[addrs6[i]] = hosts[mac].name || mac;
		};
		L.sortedKeys(ipaddrs, null, 'addr').forEach((ipv4) => {
			o.value(ipv4, ipaddrs[ipv4] ? '%s (%s)'.format(ipv4, ipaddrs[ipv4]) : ipv4);
		});
		L.sortedKeys(ip6addrs, null, 'addr').forEach((ipv6) => {
			o.value(ipv6, ip6addrs[ipv6] ? '%s (%s)'.format(ipv6, ip6addrs[ipv6]) : ipv6);
		});

		o = s.taboption('main', form.DynamicList, 'listen_port', _('Listen ports'));
		o.datatype = "list(and(port, min(1)))";
		o.default = '5353';
		o.rmempty = false;

		o = s.taboption('main', form.Flag, 'ipv6_disabled', _('Disable IPv6'));

		o = s.taboption('main', form.Flag, 'refuse_any', _('Refuse <code>ANY</code> requests'));

		o = s.taboption('main', form.Flag, 'insecure', _('Disable secure TLS cert validation'));

		o = s.taboption('main', form.Flag, 'http3', _('Enable HTTP/3 for DoH'));
		o.description = _('Allows HTTP/3 and uses it when it is faster; HTTPS fallback remains available.');

		o = s.taboption('main', form.Value, 'timeout', _('Timeout for queries to remote upstream (default: 10s)'));
		o.datatype = 'string';

		o = s.taboption('main', form.Value, 'rate_limit', _('Ratelimit (requests per second)'));
		o.datatype = "and(uinteger, min(1))";

		o = s.taboption('main', form.Value, 'udp_buf_size', _('Size of the UDP buffer in bytes. Set 0 use the system default'));
		o.datatype = 'uinteger';

		upstreamModeOption = s.taboption('main', form.ListValue, 'upstream_mode', _('Upstream selection mode'));
		upstreamModeOption.value('load_balance', _('Load balance (one upstream per request)'));
		upstreamModeOption.value('parallel', _('Parallel (first DNS response wins)'));
		upstreamModeOption.value('fastest_addr', _('Fastest address (tests returned IP addresses)'));
		upstreamModeOption.default = 'load_balance';
		upstreamModeOption.rmempty = false;
		upstreamModeOption.description = _('For the lowest DNS response time choose Parallel. Fastest address performs additional IP reachability tests and is a different, slower operation.');
		upstreamModeOption.cfgvalue = function (section_id) {
			return uci.get(conf, section_id, 'upstream_mode') ||
				(uci.get(conf, section_id, 'fastest_addr') === '1' ? 'fastest_addr' : null) ||
				(uci.get(conf, section_id, 'all_servers') === '1' ? 'parallel' : 'load_balance');
		};
		upstreamModeOption.write = function (section_id, value) {
			uci.set(conf, section_id, 'upstream_mode', value);
			uci.unset(conf, section_id, 'all_servers');
			uci.unset(conf, section_id, 'fastest_addr');
		};

		s.tab('cache', _('Cache'));

		o = s.taboption('cache', form.SectionValue, '_cache', form.NamedSection, 'cache', 'homeproxy');
		ss = o.subsection;

		so = ss.option(form.Flag, 'enabled', _('Enable Cache'));

		so = ss.option(form.Flag, 'cache_optimistic', _('Optimistic Cache'));
		so.retain = true;
		so.depends('enabled', '1');

		so = ss.option(form.Value, 'size', _('Cache size (in bytes)'));
		so.datatype = "and(uinteger, min(512))";
		so.default = '65535';
		so.retain = true;
		so.depends('enabled', '1');

		so = ss.option(form.Value, 'min_ttl', _('Min TTL value for DNS entries, in seconds'));
		so.datatype = "and(uinteger, range(1,3600))";
		so.retain = true;
		so.depends('enabled', '1');

		so = ss.option(form.Value, 'max_ttl', _('Max TTL value for DNS entries, in seconds'));
		so.datatype = "and(uinteger, min(60))";
		so.retain = true;
		so.depends('enabled', '1');

		s.tab('dns64', _('DNS64'));

		o = s.taboption('dns64', form.SectionValue, '_dns64', form.NamedSection, 'dns64', 'homeproxy');
		ss = o.subsection;

		so = ss.option(form.Flag, 'enabled', _('Enable DNS64'));

		so = ss.option(form.Value, 'dns64_prefix', _('DNS64 Prefix'));
		so.datatype = "ip6addr(1)";
		so.default = '64:ff9b::';
		so.retain = true;
		so.depends('enabled', '1');

		s.tab('edns', _('EDNS'));

		o = s.taboption('edns', form.SectionValue, '_edns', form.NamedSection, 'edns', 'homeproxy');
		ss = o.subsection;

		so = ss.option(form.Flag, 'enabled', _('Enable EDNS'));

		so = ss.option(form.Value, 'edns_addr', _('EDNS Client Address'));
		so.datatype = "ipaddr(1)";
		so.retain = true;
		so.depends('enabled', '1');

		s.tab('bogus_nxdomain', _('Bogus-NXDOMAIN'));

		o = s.taboption('bogus_nxdomain', form.SectionValue, '_bogus_nxdomain', form.NamedSection, 'bogus_nxdomain', 'homeproxy');
		ss = o.subsection;

		so = ss.option(form.DynamicList, 'ip_addr', _('Convert matching single IP responses to NXDOMAIN'));
		so.datatype = "list(ipaddr)";

		const readFormProfile = (label) => ({
			label: String(label || '').trim(),
			bootstrap: normalizedList(serverOptions.bootstrap.getUIElement('servers').getValue()),
			upstream: normalizedList(serverOptions.upstream.getUIElement('servers').getValue()),
			fallback: normalizedList(serverOptions.fallback.getUIElement('servers').getValue()),
			upstream_mode: upstreamModeOption.getUIElement('global').getValue() || currentUpstreamMode()
		});

		const modeLabel = (mode) => ({
			load_balance: _('Load balance'),
			parallel: _('Parallel'),
			fastest_addr: _('Fastest address'),
			'': _('Keep current mode')
		})[mode || ''] || mode;

		const profileDiff = (before, after) => {
			const rows = [];
			const addRow = (setting, oldValues, newValues) => {
				if (listsEqual(oldValues, newValues))
					return;
				const oldSet = new Set(oldValues);
				const newSet = new Set(newValues);
				const changes = [
					...oldValues.filter((value) => !newSet.has(value)).map((value) => '- ' + value),
					...newValues.filter((value) => !oldSet.has(value)).map((value) => '+ ' + value)
				];
				if (!changes.length)
					changes.push(_('Order changed'));
				rows.push([setting, changes.join('\n')]);
			};

			if ((before.upstream_mode || '') !== (after.upstream_mode || ''))
				rows.push([_('Upstream selection mode'), '%s → %s'.format(modeLabel(before.upstream_mode), modeLabel(after.upstream_mode))]);
			addRow(_('Bootstrap DNS'), before.bootstrap, after.bootstrap);
			addRow(_('Upstream DNS'), before.upstream, after.upstream);
			addRow(_('Fallback DNS'), before.fallback, after.fallback);
			return rows;
		};

		const renderProfileDiff = (before, after) => {
			const rows = profileDiff(before, after);
			if (!rows.length)
				return E('p', {}, _('No differences.'));
			return E('div', { 'class': 'table cbi-section-table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Setting')),
					E('div', { 'class': 'th' }, _('Changes'))
				]),
				...rows.map((row) => E('div', { 'class': 'tr' }, [
					E('div', { 'class': 'td' }, row[0]),
					E('pre', { 'class': 'td', 'style': 'white-space:pre-wrap;margin:0' }, row[1])
				]))
			]);
		};

		const loadProfileIntoForm = (profile, statusNode) => {
			if (!profile) {
				ui.addNotification(null, E('p', {}, _('The selected DNS profile no longer exists. Reload the page and try again.')), 'error');
				return;
			}
			const data = profileData(profile);
			const result = analyzeProfile(data, uci.sections(conf, 'profile'), profile['.name']);
			if (!showProfileProblems(result))
				return;
			const current = readFormProfile(_('Current form'));
			const target = Object.assign({}, data, {
				upstream_mode: data.upstream_mode || current.upstream_mode
			});
			const applyProfile = () => {
				profileListOptions.forEach((option) => serverOptions[option].getUIElement('servers').setValue(data[option]));
				if (data.upstream_mode)
					upstreamModeOption.getUIElement('global').setValue(data.upstream_mode);
				ui.hideModal();
				statusNode.textContent = _('Loaded profile “%s”. Review the values, then use Save & Apply.').format(profileTitle(profile));
				statusNode.style.color = 'var(--primary-color-medium, #37c)';
			};

			ui.showModal(_('Preview profile load'), [
				E('p', {}, _('The following current form values will be replaced by “%s”.').format(profileTitle(profile))),
				renderProfileDiff(current, target),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': ui.createHandlerFn(this, applyProfile)
					}, _('Load profile'))
				])
			]);
		};

		const persistProfile = (data, sectionName) => {
			const profiles = uci.sections(conf, 'profile');
			const result = analyzeProfile(data, profiles, sectionName);
			if (!showProfileProblems(result))
				return Promise.resolve();

			const sid = sectionName || uci.add(conf, 'profile');
			setProfileValues(sid, data);

			ui.showModal(_('Saving DNS profile'), [
				E('p', { 'class': 'spinning' }, _('Saving “%s”…').format(data.label))
			]);

			return uci.save()
				.then(() => {
					ui.hideModal();
					const select = document.querySelector('#dnsproxy-profile-select');
					const profilesAfterSave = uci.sections(conf, 'profile');
					if (select) {
						select.replaceChildren(...profilesAfterSave.map((profile) => E('option', {
							'value': profile['.name'],
							'selected': profileTitle(profile).trim().toLowerCase() === data.label.toLowerCase() ? 'selected' : null
						}, profileTitle(profile))));
					}
					ui.addNotification(null, E('p', {}, _('DNS profile “%s” was saved. Current form values were kept; use Save & Apply to activate them.').format(data.label)), 'info');
				})
				.catch((err) => {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, _('Failed to save DNS profile: %s').format(err.message || err)), 'error');
				});
		};

		const promptNewProfile = () => {
			const input = E('input', {
				'class': 'cbi-input-text',
				'type': 'text',
				'placeholder': _('Profile name'),
				'maxlength': '64',
				'autocomplete': 'off'
			});

			ui.showModal(_('Save current settings as a profile'), [
				E('p', {}, _('Bootstrap, Upstream, Fallback and the upstream selection mode will be copied from the current form. Active DNS settings are not changed until Save & Apply is used.')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Profile name')),
					E('div', { 'class': 'cbi-value-field' }, input)
				]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': ui.createHandlerFn(this, () => persistProfile(readFormProfile(input.value)))
					}, _('Save profile'))
				])
			]);
			window.setTimeout(() => input.focus(), 0);
		};

		const confirmProfileUpdate = (profile) => {
			if (!profile) {
				ui.addNotification(null, E('p', {}, _('The selected DNS profile no longer exists. Reload the page and try again.')), 'error');
				return;
			}
			const data = readFormProfile(profileTitle(profile));
			ui.showModal(_('Update DNS profile'), [
				E('p', {}, _('Review the changes that will be stored in “%s”.').format(profileTitle(profile))),
				renderProfileDiff(profileData(profile), data),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					E('button', {
						'class': 'btn cbi-button-negative important',
						'click': ui.createHandlerFn(this, () => persistProfile(data, profile['.name']))
					}, _('Update profile'))
				])
			]);
		};

		const importProfiles = () => {
			const input = E('input', {
				'class': 'cbi-input-file',
				'type': 'file',
				'accept': 'application/json,.json'
			});

			const handleImport = () => {
				const file = input.files?.[0];
				if (!file) {
					ui.addNotification(null, E('p', {}, _('Choose a JSON profile file first.')), 'error');
					return Promise.resolve();
				}
				if (file.size > 1024 * 1024) {
					ui.addNotification(null, E('p', {}, _('The profile file must not exceed 1 MiB.')), 'error');
					return Promise.resolve();
				}

				return file.text().then((text) => {
					const payload = JSON.parse(text);
					if (payload?.version !== 1 || !Array.isArray(payload.profiles) || !payload.profiles.length || payload.profiles.length > 100)
						throw new Error(_('Unsupported or empty DNS profile file.'));

					const imported = payload.profiles.map(importedProfileData);
					const importedLabels = new Set();
					const existing = uci.sections(conf, 'profile');

					imported.forEach((data) => {
						const key = data.label.toLowerCase();
						if (importedLabels.has(key))
							throw new Error(_('Imported profile names must be unique.'));
						importedLabels.add(key);

						if (profileListOptions.some((option) => data[option].length > 128))
							throw new Error(_('A DNS profile list must not contain more than 128 entries.'));

						const match = existing.find((profile) => profileTitle(profile).trim().toLowerCase() === key);
						const result = analyzeProfile(data, existing, match?.['.name']);
						if (result.errors.length)
							throw new Error(result.errors.join('\n'));
					});

					imported.forEach((data) => {
						const match = existing.find((profile) => profileTitle(profile).trim().toLowerCase() === data.label.toLowerCase());
						setProfileValues(match?.['.name'] || uci.add(conf, 'profile'), data);
					});

					return uci.save();
				}).then(() => window.location.reload()).catch((err) => {
					ui.hideModal();
					ui.addNotification(null, E('p', { 'style': 'white-space:pre-wrap' }, _('Failed to import DNS profiles: %s').format(err.message || err)), 'error');
				});
			};

			ui.showModal(_('Import DNS profiles'), [
				E('p', {}, _('Profiles are merged by name. Matching profiles are replaced; other existing profiles are kept.')),
				input,
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': ui.createHandlerFn(this, handleImport)
					}, _('Import'))
				])
			]);
		};

		const testKindLabel = (kind) => ({
			bootstrap: _('Bootstrap'),
			upstream: _('Upstream'),
			fallback: _('Fallback'),
			failover: _('Fallback activation')
		})[kind] || kind;

		const parseTestOutput = (output) => String(output || '').replace(/\r/g, '').replace(/\n+$/, '').split('\n').filter(Boolean).map((line) => {
			const fields = line.split('\t');
			if (fields.length < 9)
				throw new Error(line || _('The DNS profile test returned an unsupported result format.'));
			const numberOrNull = (value) => /^\d+$/.test(value) ? Number(value) : null;
			return {
				kind: fields[0],
				record: fields[1],
				status: fields[2],
				success: Number(fields[3]) || 0,
				attempts: Number(fields[4]) || 0,
				min: numberOrNull(fields[5]),
				avg: numberOrNull(fields[6]),
				max: numberOrNull(fields[7]),
				server: fields[8],
				details: fields.slice(9).join(' ')
			};
		});

		const executeProfileTest = (profile, data, settings) => {
			const args = [
				'--domain', settings.domain,
				'--attempts', settings.attempts,
				'--query-type', settings.queryType,
				'--upstream-mode', data.upstream_mode || currentUpstreamMode()
			];
			profileListOptions.forEach((option) => data[option].forEach((value) => args.push('--' + option, value)));
			return fs.exec_direct('/usr/libexec/dnsproxy-profile-test', args, 'text', false, true).then((output) => {
				const rows = parseTestOutput(output);
				if (!rows.length)
					throw new Error(_('The DNS profile test returned no results.'));
				return { profile, rows };
			});
		};

		const milliseconds = (value) => value == null ? '—' : _('%s ms').format(value);

		const testRowStyle = (row, fastest, slowest) => {
			if (row.status === 'error')
				return 'background-color:rgba(220,38,38,.14)';
			if (row.avg === fastest)
				return 'background-color:rgba(34,197,94,.16)';
			if (fastest !== slowest && row.avg === slowest)
				return 'background-color:rgba(234,179,8,.18)';
			return '';
		};

		const renderDetailedTest = (profile, settings, resultRows) => {
			const rows = resultRows.slice().sort((left, right) => {
				if (left.avg == null && right.avg == null)
					return right.success - left.success;
				if (left.avg == null)
					return 1;
				if (right.avg == null)
					return -1;
				return left.avg - right.avg;
			});
			const latencies = rows.map((row) => row.avg).filter((value) => value != null);
			const fastest = latencies.length ? Math.min(...latencies) : null;
			const slowest = latencies.length ? Math.max(...latencies) : null;
			const statusCell = (row) => {
				if (row.status === 'ok')
					return E('span', { 'style': 'color:green;font-weight:bold' }, _('OK'));
				if (row.status === 'partial')
					return E('span', { 'style': 'color:#b7791f;font-weight:bold' }, _('Partial'));
				return E('span', { 'style': 'color:red;font-weight:bold' }, _('Failed'));
			};

			ui.showModal(_('DNS profile test: %s').format(profileTitle(profile)), [
				E('p', {}, _('%s queries for each selected record type were sent for %s. Bootstrap, Upstream and Fallback endpoints were tested independently; fallback activation used an unavailable primary resolver.').format(settings.attempts, settings.domain)),
				E('div', { 'class': 'table cbi-section-table' }, [
					E('div', { 'class': 'tr table-titles' }, [
						E('div', { 'class': 'th' }, _('Type')),
						E('div', { 'class': 'th' }, _('Record')),
						E('div', { 'class': 'th' }, _('Server')),
						E('div', { 'class': 'th' }, _('Status')),
						E('div', { 'class': 'th' }, _('Success')),
						E('div', { 'class': 'th' }, _('Min')),
						E('div', { 'class': 'th' }, _('Average')),
						E('div', { 'class': 'th' }, _('Max')),
						E('div', { 'class': 'th' }, _('Details'))
					]),
					...rows.map((row) => E('div', { 'class': 'tr', 'style': testRowStyle(row, fastest, slowest) }, [
						E('div', { 'class': 'td' }, testKindLabel(row.kind)),
						E('div', { 'class': 'td' }, row.record),
						E('div', { 'class': 'td', 'style': 'overflow-wrap:anywhere' }, row.kind === 'failover' ? _('Configured fallback chain') : row.server),
						E('div', { 'class': 'td' }, statusCell(row)),
						E('div', { 'class': 'td' }, '%s/%s'.format(row.success, row.attempts)),
						E('div', { 'class': 'td' }, milliseconds(row.min)),
						E('div', { 'class': 'td' }, milliseconds(row.avg)),
						E('div', { 'class': 'td' }, milliseconds(row.max)),
						E('div', { 'class': 'td' }, row.details || '')
					]))
				]),
				E('p', {}, _('Green is fastest, yellow is slowest, and red indicates complete failure. Results are sorted by average response time.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn cbi-button-positive', 'click': ui.hideModal }, _('Close'))
				])
			]);
		};

		const runProfileTest = (profile, data, settings) => {
			ui.showModal(_('Testing DNS profile'), [
				E('p', { 'class': 'spinning' }, _('Resolving %s through “%s”…').format(settings.domain, profileTitle(profile)))
			]);
			return executeProfileTest(profile, data, settings)
				.then((result) => renderDetailedTest(profile, settings, result.rows))
				.catch((err) => {
					ui.showModal(_('DNS profile test failed'), [
						E('p', { 'style': 'white-space:pre-wrap' }, err.message || String(err)),
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
						])
					]);
				});
		};

		const compareProfiles = (profiles, settings) => {
			const progress = E('p', { 'class': 'spinning' });
			ui.showModal(_('Comparing DNS profiles'), [progress]);
			const results = [];
			let chain = Promise.resolve();
			profiles.forEach((profile, index) => {
				chain = chain.then(() => {
					progress.textContent = _('Testing profile %s of %s: %s').format(index + 1, profiles.length, profileTitle(profile));
					return executeProfileTest(profile, profileData(profile), settings)
						.then((result) => results.push(result))
						.catch((error) => results.push({ profile, error: error.message || String(error), rows: [] }));
				});
			});

			return chain.then(() => {
				const summaries = results.map((result) => {
					const measured = result.rows.filter((row) => row.kind !== 'failover');
					const successful = measured.filter((row) => row.avg != null);
					const success = measured.reduce((sum, row) => sum + row.success, 0);
					const attemptsTotal = measured.reduce((sum, row) => sum + row.attempts, 0);
					const successWeight = successful.reduce((sum, row) => sum + row.success, 0);
					const average = successWeight ? Math.round(successful.reduce((sum, row) => sum + row.avg * row.success, 0) / successWeight) : null;
					const minimums = successful.map((row) => row.min).filter((value) => value != null);
					const maximums = successful.map((row) => row.max).filter((value) => value != null);
					const failover = result.rows.filter((row) => row.kind === 'failover');
					return {
						name: profileTitle(result.profile),
						success,
						attempts: attemptsTotal,
						errors: attemptsTotal - success,
						min: minimums.length ? Math.min(...minimums) : null,
						avg: average,
						max: maximums.length ? Math.max(...maximums) : null,
						failover: failover.length ? (failover.every((row) => row.success > 0) ? _('OK') : _('Failed')) : _('Not configured'),
						details: result.error || ''
					};
				}).sort((left, right) => {
					if (left.avg == null && right.avg == null)
						return left.errors - right.errors;
					if (left.avg == null)
						return 1;
					if (right.avg == null)
						return -1;
					return left.avg - right.avg;
				});
				const averages = summaries.map((summary) => summary.avg).filter((value) => value != null);
				const fastest = averages.length ? Math.min(...averages) : null;
				const slowest = averages.length ? Math.max(...averages) : null;

				ui.showModal(_('DNS profile comparison'), [
					E('p', {}, _('All profiles were tested with the same domain, record type and attempt count. Endpoint averages exclude the fallback-activation check.')),
					E('div', { 'class': 'table cbi-section-table' }, [
						E('div', { 'class': 'tr table-titles' }, [
							E('div', { 'class': 'th' }, _('Profile')),
							E('div', { 'class': 'th' }, _('Success')),
							E('div', { 'class': 'th' }, _('Errors')),
							E('div', { 'class': 'th' }, _('Min')),
							E('div', { 'class': 'th' }, _('Average')),
							E('div', { 'class': 'th' }, _('Max')),
							E('div', { 'class': 'th' }, _('Fallback activation')),
							E('div', { 'class': 'th' }, _('Details'))
						]),
						...summaries.map((summary) => E('div', {
							'class': 'tr',
							'style': testRowStyle({ status: summary.avg == null ? 'error' : 'ok', avg: summary.avg }, fastest, slowest)
						}, [
							E('div', { 'class': 'td' }, summary.name),
							E('div', { 'class': 'td' }, '%s/%s'.format(summary.success, summary.attempts)),
							E('div', { 'class': 'td' }, String(summary.errors)),
							E('div', { 'class': 'td' }, milliseconds(summary.min)),
							E('div', { 'class': 'td' }, milliseconds(summary.avg)),
							E('div', { 'class': 'td' }, milliseconds(summary.max)),
							E('div', { 'class': 'td' }, summary.failover),
							E('div', { 'class': 'td' }, summary.details)
						]))
					]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn cbi-button-positive', 'click': ui.hideModal }, _('Close'))
					])
				]);
			});
		};

		const showTestOptions = (title, description, onRun) => {
			const domainInput = E('input', {
				'class': 'cbi-input-text',
				'type': 'text',
				'value': storedTestDomain(),
				'placeholder': 'example.com',
				'maxlength': '254',
				'autocomplete': 'off',
				'spellcheck': 'false'
			});
			const attemptsSelect = E('select', { 'class': 'cbi-input-select' }, ['1', '3', '5', '10'].map((value) => E('option', {
				'value': value,
				'selected': value === '3' ? 'selected' : null
			}, value)));
			const queryTypeSelect = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'A' }, 'A'),
				E('option', { 'value': 'AAAA' }, 'AAAA'),
				E('option', { 'value': 'both' }, 'A + AAAA')
			]);
			const validationMessage = E('p', { 'style': 'color:var(--error-color, #c00);white-space:pre-wrap' });
			const startTest = () => {
				const domain = String(domainInput.value || '').trim();
				const validation = validateTestDomain(domain);
				if (validation !== true) {
					validationMessage.textContent = validation;
					domainInput.focus();
					return Promise.resolve();
				}
				rememberTestDomain(domain);
				return onRun({ domain, attempts: attemptsSelect.value, queryType: queryTypeSelect.value });
			};

			domainInput.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					startTest();
				}
			});

			ui.showModal(title, [
				E('p', {}, description),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Test domain')),
					E('div', { 'class': 'cbi-value-field' }, domainInput)
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Attempts per record type')),
					E('div', { 'class': 'cbi-value-field' }, attemptsSelect)
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('DNS record type')),
					E('div', { 'class': 'cbi-value-field' }, queryTypeSelect)
				]),
				validationMessage,
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': ui.createHandlerFn(this, startTest)
					}, _('Run test'))
				])
			]);
			window.setTimeout(() => domainInput.focus(), 0);
			return Promise.resolve();
		};

		const testProfile = (profile) => {
			if (!profile) {
				ui.addNotification(null, E('p', {}, _('The selected DNS profile no longer exists. Reload the page and try again.')), 'error');
				return Promise.resolve();
			}
			const data = profileData(profile);
			const result = analyzeProfile(data, uci.sections(conf, 'profile'), profile['.name']);
			if (!showProfileProblems(result))
				return Promise.resolve();
			return showTestOptions(_('Test DNS profile'),
				_('Choose one domain, the number of measurements and DNS record type. The domain is remembered only in this browser.'),
				(settings) => runProfileTest(profile, data, settings));
		};

		s.tab('servers', _('Upstreams'));

		o = s.taboption('servers', form.DummyValue, '_profile_switcher', _('DNS profiles'),
			_('Load a reusable Bootstrap, Upstream, Fallback and selection-mode configuration into the form. Review it before using Save & Apply.'));
		o.renderWidget = function () {
			const profiles = uci.sections(conf, 'profile');
			const active = activeProfile(profiles);
			const status = E('p', {}, active ?
				_('Active profile: %s').format(profileTitle(active)) :
				_('Active profile: Custom configuration'));
			const select = E('select', {
				'id': 'dnsproxy-profile-select',
				'class': 'cbi-input-select',
				'disabled': profiles.length ? null : ''
			}, profiles.map((profile) => E('option', {
				'value': profile['.name'],
				'selected': active && active['.name'] === profile['.name'] ? 'selected' : null
			}, profileTitle(profile))));
			const selectedProfile = () => uci.sections(conf, 'profile').find((profile) => profile['.name'] === select.value);

			return E('div', {}, [
				status,
				E('div', { 'style': 'display:flex;gap:.75em;align-items:center;flex-wrap:wrap' }, [
					select,
					E('button', {
						'class': 'cbi-button cbi-button-positive important',
						'disabled': profiles.length ? null : '',
						'click': ui.createHandlerFn(this, () => loadProfileIntoForm(selectedProfile(), status))
					}, _('Load profile')),
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'disabled': profiles.length ? null : '',
						'click': ui.createHandlerFn(this, () => testProfile(selectedProfile()))
					}, _('Test profile')),
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'disabled': profiles.length > 1 ? null : '',
						'click': ui.createHandlerFn(this, () => showTestOptions(
							_('Compare DNS profiles'),
							_('Every saved profile will be tested sequentially with identical settings. This can take several minutes.'),
							(settings) => compareProfiles(uci.sections(conf, 'profile'), settings)
						))
					}, _('Compare profiles')),
					E('button', {
						'class': 'cbi-button cbi-button-add',
						'click': ui.createHandlerFn(this, promptNewProfile)
					}, _('Save current as profile')),
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'disabled': profiles.length ? null : '',
						'click': ui.createHandlerFn(this, () => confirmProfileUpdate(selectedProfile()))
					}, _('Update selected profile'))
				]),
				profiles.length ? '' : E('p', {}, _('Create and save a profile in the “DNS profile templates” section below first.'))
			]);
		};

		o = s.taboption('servers', form.SectionValue, '_servers', form.NamedSection, 'servers', 'homeproxy');
		ss = o.subsection;

		serverOptions.bootstrap = ss.option(form.DynamicList, 'bootstrap', _('Bootstrap DNS Server'));
		serverOptions.bootstrap.validate = validateUniqueServerValue('bootstrap');

		serverOptions.upstream = ss.option(form.DynamicList, 'upstream', _('Upstream DNS Server'));
		serverOptions.upstream.rmempty = false;
		serverOptions.upstream.validate = validateUniqueServerValue('upstream');

		serverOptions.fallback = ss.option(form.DynamicList, 'fallback', _('Fallback DNS Server'));
		serverOptions.fallback.validate = validateUniqueServerValue('fallback');

		o = s.taboption('servers', form.SectionValue, '_profiles', form.GridSection, 'profile', _('DNS profile templates'),
			_('Create and edit reusable DNS templates. Loading a template does not modify the template itself.'));
		ss = o.subsection;
		ss.anonymous = true;
		ss.addremove = true;
		ss.nodescriptions = true;
		ss.addbtntitle = _('Add DNS profile');

		so = ss.option(form.Value, 'label', _('Profile name'));
		so.rmempty = false;
		so.validate = function (section_id, value) {
			const label = String(value || '').trim();
			if (!label)
				return _('Profile name is required.');
			if (label.length > 64)
				return _('Profile name must not exceed 64 characters.');
			if (uci.sections(conf, 'profile').some((profile) => profile['.name'] !== section_id && profileTitle(profile).trim().toLowerCase() === label.toLowerCase()))
				return _('Profile names must be unique.');
			return true;
		};

		so = ss.option(form.ListValue, 'upstream_mode', _('Upstream selection mode'));
		so.value('', _('Keep current mode'));
		so.value('load_balance', _('Load balance (one upstream per request)'));
		so.value('parallel', _('Parallel (first DNS response wins)'));
		so.value('fastest_addr', _('Fastest address (tests returned IP addresses)'));
		so.rmempty = true;

		so = ss.option(form.DynamicList, 'bootstrap', _('Bootstrap DNS'));
		so.modalonly = true;
		so.validate = validateUniqueServerValue('bootstrap');

		so = ss.option(form.DynamicList, 'upstream', _('Upstream DNS'));
		so.rmempty = false;
		so.modalonly = true;
		so.validate = validateUniqueServerValue('upstream');

		so = ss.option(form.DynamicList, 'fallback', _('Fallback DNS'));
		so.modalonly = true;
		so.validate = validateUniqueServerValue('fallback');

		const renderProfileEditor = o.render.bind(o);
		o.render = (...args) => Promise.resolve(renderProfileEditor(...args)).then((node) => E('details', {
			'class': 'cbi-section'
		}, [
			E('summary', { 'style': 'cursor:pointer;font-weight:bold;padding:.5em 0' }, _('Manage DNS profile templates')),
			E('div', { 'style': 'display:flex;gap:.75em;align-items:center;flex-wrap:wrap;margin:.5em 0 1em' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, () => {
						const profiles = uci.sections(conf, 'profile');
						const selected = document.querySelector('#dnsproxy-profile-select')?.value;
						const profile = profiles.find((item) => item['.name'] === selected);
						if (profile)
							exportProfiles([profile], 'dnsproxy-profile-' + profile['.name'] + '.json');
					})
				}, _('Export selected')),
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, () => exportProfiles(uci.sections(conf, 'profile'), 'dnsproxy-profiles.json'))
				}, _('Export all')),
				E('button', {
					'class': 'cbi-button cbi-button-add',
					'click': ui.createHandlerFn(this, importProfiles)
				}, _('Import profiles'))
			]),
			node
		]));

		return m.render()
		.then(L.bind(function(m, nodes) {
			poll.add(L.bind(function() {
				return Promise.all([
					getServiceStatus()
				]).then(L.bind(this.poll_status, this, nodes));
			}, this), 3);
			return nodes;
		}, this, m));
	}
});
