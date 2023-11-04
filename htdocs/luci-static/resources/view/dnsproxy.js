'use strict';
'require form';
'require fs';
'require uci';
'require rpc';
'require poll';
'require view';
'require tools.widgets as widgets';

var conf = 'dnsproxy';
var instance = 'dnsproxy';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList(conf), {})
		.then(function (res) {
			var isrunning = false;
			try {
				isrunning = res[conf]['instances'][instance]['running'];
			} catch (e) { }
			return isrunning;
		});
}

return view.extend({

	load: function() {
	return Promise.all([
		getServiceStatus(),
		callHostHints(),
		uci.load('dnsproxy')
	]);
	},

	poll_status: function(nodes, stat) {
		var isRunning = stat[0],
			view = nodes.querySelector('#service_status');

		if (isRunning) {
			view.innerHTML = "<span style=\"color:green;font-weight:bold\">" + instance + " - " + _("SERVER RUNNING") + "</span>";
		} else {
			view.innerHTML = "<span style=\"color:red;font-weight:bold\">" + instance + " - " + _("SERVER NOT RUNNING") + "</span>";
		}
		return;
	},

	render: function(res) {
		var isRunning = res[0],
			hosts = res[1];

		var m, s, o;

		m = new form.Map('dnsproxy', _('DNS Proxy'));

		s = m.section(form.NamedSection, '_status');
		s.anonymous = true;
		s.render = function (section_id) {
			return E('div', { class: 'cbi-section' }, [
				E('div', { id: 'service_status' }, _('Collecting data ...'))
			]);
		};

		s = m.section(form.NamedSection, 'global', 'dnsproxy', _('Main Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = o.disabled;

		o = s.option(form.Flag, 'verbose', _('Verbose'));

		o = s.option(form.Value, 'log_file', _('Log file path'));
		o.datatype = 'file';

		o = s.option(form.DynamicList, 'listen_addr', _('Listen address'));
		o.datatype = "list(ipaddr(1))";
		o.value('127.0.0.1');
		o.value('::1');

		var ipaddrs = {}, ip6addrs = {};
		Object.keys(hosts).forEach(function(mac) {
			var addrs = L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4),
				addrs6 = L.toArray(hosts[mac].ip6addrs || hosts[mac].ipv6);

			for (var i = 0; i < addrs.length; i++)
				ipaddrs[addrs[i]] = hosts[mac].name || mac;
			for (var i = 0; i < addrs6.length; i++)
				ip6addrs[addrs6[i]] = hosts[mac].name || mac;
		});
		L.sortedKeys(ipaddrs, null, 'addr').forEach(function(ipv4) {
			o.value(ipv4, ipaddrs[ipv4] ? '%s (%s)'.format(ipv4, ipaddrs[ipv4]) : ipv4);
		});
		L.sortedKeys(ip6addrs, null, 'addr').forEach(function(ipv6) {
			o.value(ipv6, ip6addrs[ipv6] ? '%s (%s)'.format(ipv6, ip6addrs[ipv6]) : ipv6);
		});

		o = s.option(form.DynamicList, 'listen_port', _('Listen ports'));
		o.datatype = "list(and(port, min(1)))";
		o.default = '5353';
		o.rmempty = false;

		o = s.option(form.Flag, 'ipv6_disabled', _('Disable IPv6'));

		o = s.option(form.Flag, 'refuse_any', _('Refuse <code>ANY</code> requests'));

		o = s.option(form.Flag, 'insecure', _('Disable secure TLS cert validation'));

		o = s.option(form.Flag, 'http3', _('DoH uses H3 first'));

		o = s.option(form.Value, 'timeout', _('Timeout for queries to remote upstream (default: 10s)'));
		o.datatype = 'string';

		o = s.option(form.Value, 'rate_limit', _('Ratelimit (requests per second)'));
		o.datatype = "and(uinteger, min(1))";

		o = s.option(form.Value, 'udp_buf_size', _('Size of the UDP buffer in bytes. Set 0 use the system default'));
		o.datatype = 'uinteger';

		o = s.option(form.Flag, 'all_servers', _('Parallel queries all upstream'));

		o = s.option(form.Flag, 'fastest_addr', _('Respond to A or AAAA requests only with the fastest IP address'));
		o.depends('all_servers', '1');

		s = m.section(form.NamedSection, 'cache', 'dnsproxy', _('Cache Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enable Cache'));

		o = s.option(form.Flag, 'cache_optimistic', _('Optimistic Cache'));
		o.retain = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'size', _('Cache size (in bytes)'));
		o.datatype = "and(uinteger, min(512))";
		o.default = '65535';
		o.retain = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'min_ttl', _('Min TTL value for DNS entries, in seconds'));
		o.datatype = "and(uinteger, range(1,3600))";
		o.retain = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'max_ttl', _('Max TTL value for DNS entries, in seconds'));
		o.datatype = "and(uinteger, min(60))";
		o.retain = true;
		o.depends('enabled', '1');

		s = m.section(form.NamedSection, 'dns64', 'dnsproxy', _('DNS64 Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enable DNS64'));

		o = s.option(form.Value, 'dns64_prefix', _('DNS64 Prefix'));
		o.datatype = "ip6addr(1)";
		o.default = '64:ff9b::';
		o.retain = true;
		o.depends('enabled', '1');

		s = m.section(form.NamedSection, 'edns', 'dnsproxy', _('EDNS Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enable EDNS'));

		o = s.option(form.Value, 'edns_addr', _('EDNS Client Address'));
		o.datatype = "ipaddr(1)";
		o.retain = true;
		o.depends('enabled', '1');

		s = m.section(form.NamedSection, 'bogus_nxdomain', 'dnsproxy', _('Bogus-NXDOMAIN'));
		s.anonymous = true;

		o = s.option(form.DynamicList, 'ip_addr', _('Convert matching single IP responses to NXDOMAIN'));
		o.datatype = "list(ipaddr)";

		s = m.section(form.NamedSection, 'servers', 'dnsproxy', _('Upstreams'));
		s.anonymous = true;

		o = s.option(form.DynamicList, 'bootstrap', _('Bootstrap DNS Server'));

		o = s.option(form.DynamicList, 'upstream', _('Upstream DNS Server'));
		o.rmempty = false;

		o = s.option(form.DynamicList, 'fallback', _('Fallback DNS Server'));

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
