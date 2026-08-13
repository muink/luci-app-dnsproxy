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

function applyProfile(profileName) {
	const profile = uci.sections(conf, 'profile').find((item) => item['.name'] === profileName);

	if (!profile) {
		ui.addNotification(null, E('p', _('The selected DNS profile no longer exists. Reload the page and try again.')), 'error');
		return Promise.resolve();
	}

	const upstreams = L.toArray(profile.upstream).filter(Boolean);
	if (!upstreams.length) {
		ui.addNotification(null, E('p', _('The selected DNS profile has no upstream servers.')), 'error');
		return Promise.resolve();
	}

	['bootstrap', 'upstream', 'fallback'].forEach((option) => {
		const values = L.toArray(profile[option]).filter(Boolean);
		uci.set(conf, 'servers', option, values.length ? values : null);
	});

	ui.showModal(_('Applying DNS profile'), [
		E('p', { 'class': 'spinning' }, _('Saving “%s” and reloading DNS Proxy…').format(profileTitle(profile)))
	]);

	return uci.save()
		.then(() => uci.apply())
		.then(() => {
			ui.hideModal();
			ui.addNotification(null, E('p', _('DNS profile “%s” has been applied.').format(profileTitle(profile))), 'info');
			window.setTimeout(() => window.location.reload(), 800);
		})
		.catch((err) => {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Failed to apply DNS profile: %s').format(err.message || err)), 'error');
		});
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

		let m, s, o, ss, so;

		m = new form.Map('dnsproxy', _('DNS Proxy'));

		s = m.section(form.NamedSection, '_status');
		s.render = function (section_id) {
			return E('div', { class: 'cbi-section' }, [
				E('div', { id: 'service_status' }, _('Collecting data ...'))
			]);
		};

		s = m.section(form.NamedSection, '_profile_switcher');
		s.render = function () {
			const profiles = uci.sections(conf, 'profile');
			const select = E('select', {
				'id': 'dnsproxy-profile-select',
				'class': 'cbi-input-select',
				'disabled': profiles.length ? null : ''
			}, profiles.map((profile) => E('option', {
				'value': profile['.name']
			}, profileTitle(profile))));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('DNS profiles')),
				E('p', {}, _('A profile replaces Bootstrap, Upstream and Fallback lists together, then immediately reloads DNS Proxy. Unsaved changes elsewhere on this page are not included.')),
				E('div', { 'style': 'display:flex;gap:.75em;align-items:center;flex-wrap:wrap' }, [
					select,
					E('button', {
						'class': 'cbi-button cbi-button-positive important',
						'disabled': profiles.length ? null : '',
						'click': ui.createHandlerFn(this, () => applyProfile(select.value))
					}, _('Apply selected profile'))
				]),
				profiles.length ? '' : E('p', {}, _('Create and save a profile in the “DNS profile templates” section below first.'))
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

		o = s.taboption('main', form.ListValue, 'upstream_mode', _('Upstream selection mode'));
		o.value('load_balance', _('Load balance (one upstream per request)'));
		o.value('parallel', _('Parallel (first DNS response wins)'));
	o.value('fastest_addr', _('Fastest address (tests returned IP addresses)'));
	o.default = 'load_balance';
	o.rmempty = false;
	o.description = _('For the lowest DNS response time choose Parallel. Fastest address performs additional IP reachability tests and is a different, slower operation.');
	o.cfgvalue = function (section_id) {
		return uci.get(conf, section_id, 'upstream_mode') ||
			(uci.get(conf, section_id, 'fastest_addr') === '1' ? 'fastest_addr' : null) ||
			(uci.get(conf, section_id, 'all_servers') === '1' ? 'parallel' : 'load_balance');
	};
	o.write = function (section_id, value) {
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

		s.tab('servers', _('Upstreams'));

		o = s.taboption('servers', form.SectionValue, '_servers', form.NamedSection, 'servers', 'homeproxy');
		ss = o.subsection;

		so = ss.option(form.DynamicList, 'bootstrap', _('Bootstrap DNS Server'));

		so = ss.option(form.DynamicList, 'upstream', _('Upstream DNS Server'));
		so.rmempty = false;

		so = ss.option(form.DynamicList, 'fallback', _('Fallback DNS Server'));

		s = m.section(form.GridSection, 'profile', _('DNS profile templates'),
			_('Create reusable templates here. Applying a template does not modify the template itself.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add DNS profile');

		o = s.option(form.Value, 'label', _('Profile name'));
		o.rmempty = false;

		o = s.option(form.DynamicList, 'bootstrap', _('Bootstrap DNS'));
		o.modalonly = true;

		o = s.option(form.DynamicList, 'upstream', _('Upstream DNS'));
		o.rmempty = false;
		o.modalonly = true;

		o = s.option(form.DynamicList, 'fallback', _('Fallback DNS'));
		o.modalonly = true;

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
